CREATE TABLE "mail_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"agent_id" uuid,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" varchar(200) DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"error" varchar(300),
	"sent_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"detail" text,
	"elapsed_ms" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "trigger_words" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "publish_status" varchar(16) DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "visibility" varchar(16) DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "is_builtin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "builtin_key" varchar(40);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "run_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "category" varchar(30) DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "visibility" varchar(16) DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "manifest" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "scan_result" jsonb DEFAULT '{"level":"pass","hits":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "is_builtin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_id_scheduled_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_outbox_status_idx" ON "mail_outbox" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mail_outbox_creator_idx" ON "mail_outbox" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "task_runs_task_idx" ON "task_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_runs_started_idx" ON "task_runs" USING btree ("started_at");