import { Migration } from '@mikro-orm/migrations';

/** Adds durable scheduling metadata for the PENDING_REFERENCE worker. */
export class Migration20261108000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "reference_attempts" integer not null default 0,
        add column "reference_next_attempt_at" timestamptz;

      update "wager_transactions"
      set "reference_next_attempt_at" = now()
      where "status" = 'PENDING_REFERENCE';

      alter table "wager_transactions"
        add constraint "wager_transactions_reference_attempts_non_negative_ck"
        check ("reference_attempts" >= 0);

      create index "wager_transactions_pending_reference_due_idx"
        on "wager_transactions" ("reference_next_attempt_at", "created_at", "id")
        where "status" = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop index if exists "wager_transactions_pending_reference_due_idx";
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_reference_attempts_non_negative_ck",
        drop column if exists "reference_next_attempt_at",
        drop column if exists "reference_attempts";
    `);
  }
}
