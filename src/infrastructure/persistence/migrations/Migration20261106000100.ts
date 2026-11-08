import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid primary key,
        "player_id" uuid not null,
        "currency" char(3) not null,
        "balance" numeric(20, 2) not null default 0,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "wallets_balance_non_negative_ck" check ("balance" >= 0),
        constraint "wallets_version_positive_ck" check ("version" >= 1),
        constraint "wallets_currency_format_ck" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_player_currency_uq" unique ("player_id", "currency"),
        constraint "wallets_id_player_currency_uq" unique ("id", "player_id", "currency"),
        constraint "wallets_id_currency_uq" unique ("id", "currency")
      );

      create function enforce_wallet_version() returns trigger as $$
      begin
        if new."player_id" is distinct from old."player_id" or new."currency" is distinct from old."currency" then
          raise exception 'wallet identity and currency are immutable';
        end if;
        if new."balance" is distinct from old."balance" then
          if new."version" <> old."version" + 1 then
            raise exception 'wallet version must increase by exactly one when balance changes';
          end if;
        elsif new."version" <> old."version" then
          raise exception 'wallet version can change only when balance changes';
        end if;
        return new;
      end;
      $$ language plpgsql;

      create trigger "wallet_version_guard_trg"
        before update on "wallets"
        for each row execute function enforce_wallet_version();

      create table "wager_transactions" (
        "id" uuid primary key,
        "provider_id" varchar(120) not null,
        "external_transaction_id" varchar(180) not null,
        "idempotency_key" varchar(240) not null,
        "payload_hash" char(64) not null,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" varchar(180) not null,
        "game_id" varchar(180) not null,
        "kind" varchar(16) not null,
        "amount" numeric(20, 2) not null,
        "currency" char(3) not null,
        "reference_external_transaction_id" varchar(180),
        "reference_transaction_id" uuid,
        "status" varchar(24) not null,
        "failure_code" varchar(80),
        "response_balance" numeric(20, 2),
        "created_at" timestamptz not null default now(),
        "processed_at" timestamptz,
        constraint "wager_transactions_wallet_owner_currency_fk"
          foreign key ("wallet_id", "player_id", "currency")
          references "wallets"("id", "player_id", "currency") on delete restrict,
        constraint "wager_transactions_id_wallet_uq" unique ("id", "wallet_id"),
        constraint "wager_transactions_reference_identity_uq"
          unique ("id", "provider_id", "external_transaction_id", "player_id", "wallet_id", "round_id", "currency"),
        constraint "wager_transactions_reference_identity_fk"
          foreign key ("reference_transaction_id", "provider_id", "reference_external_transaction_id", "player_id", "wallet_id", "round_id", "currency")
          references "wager_transactions"("id", "provider_id", "external_transaction_id", "player_id", "wallet_id", "round_id", "currency") on delete restrict,
        constraint "wager_transactions_reference_not_self_ck"
          check ("reference_transaction_id" is null or "reference_transaction_id" <> "id"),
        constraint "wager_transactions_reference_external_required_ck"
          check ("reference_transaction_id" is null or "reference_external_transaction_id" is not null),
        constraint "wager_transactions_kind_ck" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_ck" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_amount_positive_ck" check ("amount" > 0),
        constraint "wager_transactions_currency_format_ck" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_hash_format_ck" check ("payload_hash" ~ '^[0-9a-f]{64}$'),
        constraint "wager_transactions_reference_required_ck" check ("kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null),
        constraint "wager_transactions_terminal_timestamp_ck" check ("status" not in ('PROCESSED', 'REJECTED', 'FAILED') or "processed_at" is not null),
        constraint "wager_transactions_failure_code_ck" check ("status" not in ('REJECTED', 'FAILED') or "failure_code" is not null),
        constraint "wager_transactions_idempotency_uq" unique ("idempotency_key"),
        constraint "wager_transactions_provider_external_uq" unique ("provider_id", "external_transaction_id")
      );

      create index "wager_transactions_wallet_created_idx" on "wager_transactions" ("wallet_id", "created_at" desc);
      create index "wager_transactions_pending_reference_idx" on "wager_transactions" ("created_at") where "status" = 'PENDING_REFERENCE';
      create unique index "wager_transactions_reference_kind_uq" on "wager_transactions" ("reference_transaction_id", "kind") where "kind" in ('REFUND', 'ROLLBACK') and "reference_transaction_id" is not null;

      create table "wallet_ledger_entries" (
        "id" uuid primary key,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(6) not null,
        "amount" numeric(20, 2) not null,
        "currency" char(3) not null,
        "balance_before" numeric(20, 2) not null,
        "balance_after" numeric(20, 2) not null,
        "wallet_version" integer not null,
        "created_at" timestamptz not null default now(),
        constraint "wallet_ledger_wallet_currency_fk"
          foreign key ("wallet_id", "currency") references "wallets"("id", "currency") on delete restrict,
        constraint "wallet_ledger_transaction_wallet_fk"
          foreign key ("transaction_id", "wallet_id") references "wager_transactions"("id", "wallet_id") on delete restrict,
        constraint "wallet_ledger_wallet_version_ck" check ("wallet_version" >= 1),
        constraint "wallet_ledger_direction_ck" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_amount_positive_ck" check ("amount" > 0),
        constraint "wallet_ledger_balances_non_negative_ck" check ("balance_before" >= 0 and "balance_after" >= 0),
        constraint "wallet_ledger_currency_format_ck" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallet_ledger_balance_arithmetic_ck" check (
          ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount") or
          ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
        ),
        constraint "wallet_ledger_transaction_wallet_uq" unique ("transaction_id", "wallet_id"),
        constraint "wallet_ledger_wallet_version_uq" unique ("wallet_id", "wallet_version")
      );

      create index "wallet_ledger_wallet_created_idx" on "wallet_ledger_entries" ("wallet_id", "wallet_version" desc);

      create function assert_wallet_ledger_sequence() returns trigger as $$
      declare
        previous_version integer;
        previous_balance numeric(20,2);
      begin
        select "wallet_version", "balance_after" into previous_version, previous_balance
          from "wallet_ledger_entries"
          where "wallet_id" = new."wallet_id" and "wallet_version" < new."wallet_version"
          order by "wallet_version" desc
          limit 1;

        if found then
          if new."wallet_version" <> previous_version + 1 or new."balance_before" <> previous_balance then
            raise exception 'ledger wallet version or balance sequence is discontinuous';
          end if;
        elsif new."wallet_version" not in (1, 2) or new."balance_before" <> 0 then
          raise exception 'first ledger entry must begin at zero on wallet version 1 or 2';
        end if;

        return null;
      end;
      $$ language plpgsql;

      create constraint trigger "wallet_ledger_sequence_trg"
        after insert on "wallet_ledger_entries"
        deferrable initially deferred
        for each row execute function assert_wallet_ledger_sequence();

      create function assert_wallet_ledger_consistency() returns trigger as $$
      declare
        target_wallet_id uuid;
        stored_balance numeric(20,2);
        stored_version integer;
        ledger_balance numeric(20,2);
        ledger_version integer;
      begin
        if tg_table_name = 'wallets' then
          target_wallet_id := new."id";
        else
          target_wallet_id := new."wallet_id";
        end if;

        select "balance", "version" into stored_balance, stored_version
          from "wallets" where "id" = target_wallet_id;
        if not found then
          return null;
        end if;

        select "balance_after", "wallet_version" into ledger_balance, ledger_version
          from "wallet_ledger_entries"
          where "wallet_id" = target_wallet_id
          order by "wallet_version" desc
          limit 1;

        if found then
          if ledger_balance <> stored_balance or ledger_version <> stored_version then
            raise exception 'wallet balance/version does not match its latest ledger entry';
          end if;
        elsif stored_balance <> 0 or stored_version <> 1 then
          raise exception 'wallet with non-zero balance/version must have an opening or movement ledger entry';
        end if;

        return null;
      end;
      $$ language plpgsql;

      create constraint trigger "wallet_balance_ledger_consistency_wallet_trg"
        after insert or update of "balance", "version" on "wallets"
        deferrable initially deferred
        for each row execute function assert_wallet_ledger_consistency();

      create constraint trigger "wallet_balance_ledger_consistency_entry_trg"
        after insert on "wallet_ledger_entries"
        deferrable initially deferred
        for each row execute function assert_wallet_ledger_consistency();

      create function prevent_wallet_ledger_mutation() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries is append-only';
      end;
      $$ language plpgsql;

      create trigger "wallet_ledger_append_only_trg"
        before update or delete on "wallet_ledger_entries"
        for each row execute function prevent_wallet_ledger_mutation();

      create table "inbox_messages" (
        "id" uuid primary key,
        "consumer_name" varchar(120) not null,
        "message_id" varchar(200) not null,
        "payload_hash" char(64) not null,
        "received_at" timestamptz not null default now(),
        "processed_at" timestamptz,
        constraint "inbox_payload_hash_format_ck" check ("payload_hash" ~ '^[0-9a-f]{64}$'),
        constraint "inbox_consumer_message_uq" unique ("consumer_name", "message_id")
      );

      create table "outbox_messages" (
        "id" uuid primary key,
        "aggregate_id" uuid not null,
        "event_type" varchar(120) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz,
        "published_at" timestamptz,
        "created_at" timestamptz not null default now(),
        constraint "outbox_attempts_non_negative_ck" check ("attempts" >= 0)
      );

      create index "outbox_pending_idx" on "outbox_messages" ("next_attempt_at", "created_at") where "published_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop table if exists "outbox_messages";
      drop table if exists "inbox_messages";
      drop trigger if exists "wallet_balance_ledger_consistency_entry_trg" on "wallet_ledger_entries";
      drop trigger if exists "wallet_balance_ledger_consistency_wallet_trg" on "wallets";
      drop function if exists assert_wallet_ledger_consistency();
      drop trigger if exists "wallet_ledger_sequence_trg" on "wallet_ledger_entries";
      drop function if exists assert_wallet_ledger_sequence();
      drop trigger if exists "wallet_ledger_append_only_trg" on "wallet_ledger_entries";
      drop function if exists prevent_wallet_ledger_mutation();
      drop trigger if exists "wallet_version_guard_trg" on "wallets";
      drop function if exists enforce_wallet_version();
      drop table if exists "wallet_ledger_entries";
      drop table if exists "wager_transactions";
      drop table if exists "wallets";
    `);
  }
}
