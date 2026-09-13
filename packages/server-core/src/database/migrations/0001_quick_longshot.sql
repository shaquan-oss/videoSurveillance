CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(60) NOT NULL,
	"description" varchar(300),
	"system_prompt" text NOT NULL,
	"model_key" varchar(60),
	"scope_kb_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"icon" varchar(20) DEFAULT '🤖' NOT NULL,
	"owner_id" uuid NOT NULL,
	"department_id" uuid,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"cron" varchar(60) NOT NULL,
	"prompt" text NOT NULL,
	"model_key" varchar(60),
	"scope_kb_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(60) NOT NULL,
	"description" varchar(300),
	"trigger_words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"author_id" uuid NOT NULL,
	"install_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "agents_public_idx" ON "agents" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "tasks_owner_idx" ON "scheduled_tasks" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "scheduled_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "skills_status_idx" ON "skills" USING btree ("status");--> statement-breakpoint
CREATE INDEX "skills_author_idx" ON "skills" USING btree ("author_id");