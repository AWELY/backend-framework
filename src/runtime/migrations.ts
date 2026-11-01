import type { Migration } from "../db/migrations";

/**
 * جداول "وقت التشغيل" (Runtime): ليست بيانات تجارية، بل ما يحتاجه الإطار نفسه ليعمل بأمان
 * على أكثر من نسخة خادم، دون أي نظام تخزين ثانٍ (لا Redis):
 *
 *   idempotency_keys : ردود الطلبات المحفوظة بمفتاح Idempotency-Key، لمنع تكرار الطلب عند إعادة الإرسال.
 *   outbox_events    : الأحداث المكتوبة في نفس معاملة التغيير، يوصلها العامل إلى المستمعين لاحقاً.
 *   jobs             : طابور المهام في الخلفية (تنظيف، إلغاء الطلبات غير المدفوعة...).
 *   rate_limits      : عدّادات حد المحاولات، مشتركة بين كل النسخ.
 *   auth_sessions    : جلسات الدخول، ليمكن إلغاء توكن قبل انتهاء مدته.
 *   audit_log        : من فعل ماذا ومتى (كل كتابة من المالك أو موظف).
 *
 * تُطبَّق تلقائياً مع migrations الوحدات (createCommerceApp و npm run migrate).
 */
export const runtimeMigrations: Migration[] = [
  {
    id: "0900_runtime_tables",
    up: `
      CREATE TABLE idempotency_keys (
        scope         TEXT NOT NULL,
        key           TEXT NOT NULL,
        request_hash  TEXT NOT NULL,
        status_code   INTEGER,
        response_body JSONB,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at  TIMESTAMPTZ,
        PRIMARY KEY (scope, key)
      );

      CREATE TABLE outbox_events (
        id                  BIGSERIAL PRIMARY KEY,
        event               TEXT NOT NULL,
        payload             JSONB,
        sensitive           BOOLEAN NOT NULL DEFAULT false,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        available_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_until        TIMESTAMPTZ,
        attempts            INTEGER NOT NULL DEFAULT 0,
        completed_listeners INTEGER[] NOT NULL DEFAULT '{}',
        last_error          TEXT,
        processed_at        TIMESTAMPTZ,
        dead_at             TIMESTAMPTZ
      );
      CREATE INDEX outbox_events_pending_idx ON outbox_events (available_at, id)
        WHERE processed_at IS NULL AND dead_at IS NULL;

      CREATE TABLE jobs (
        id           BIGSERIAL PRIMARY KEY,
        name         TEXT NOT NULL,
        payload      JSONB NOT NULL DEFAULT '{}',
        run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        dedupe_key   TEXT UNIQUE,
        attempts     INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        locked_until TIMESTAMPTZ,
        last_error   TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        done_at      TIMESTAMPTZ,
        dead_at      TIMESTAMPTZ
      );
      CREATE INDEX jobs_due_idx ON jobs (run_at, id) WHERE done_at IS NULL AND dead_at IS NULL;

      CREATE TABLE rate_limits (
        key      TEXT PRIMARY KEY,
        count    INTEGER NOT NULL,
        reset_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE auth_sessions (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        principal_type TEXT NOT NULL CHECK (principal_type IN ('customer', 'staff')),
        principal_id   UUID NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at     TIMESTAMPTZ NOT NULL,
        revoked_at     TIMESTAMPTZ,
        ip             TEXT,
        user_agent     TEXT
      );
      CREATE INDEX auth_sessions_principal_idx ON auth_sessions (principal_type, principal_id);

      CREATE TABLE audit_log (
        id          BIGSERIAL PRIMARY KEY,
        at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor_type  TEXT NOT NULL,
        actor_id    TEXT,
        actor_role  TEXT NOT NULL,
        action      TEXT NOT NULL,
        route       TEXT,
        path        TEXT NOT NULL,
        params      JSONB NOT NULL DEFAULT '{}',
        status_code INTEGER NOT NULL,
        request_id  TEXT,
        ip          TEXT,
        body        JSONB
      );
      CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
      CREATE INDEX audit_log_actor_idx ON audit_log (actor_type, actor_id);
    `,
  },
];
