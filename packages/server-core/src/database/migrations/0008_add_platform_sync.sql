CREATE TABLE "kb_sync_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kb_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"checksum" varchar(128) NOT NULL,
	"platform_doc_id" varchar(80),
	"remote_paragraphs" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"error" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "run_mode" varchar(12) DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "platform_assistant_code" varchar(80);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "platform_session_id" varchar(80);--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "platform_lib_id" varchar(80);--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "platform_category_id" varchar(80);--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "platform_version" varchar(40);--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "platform_last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kb_sync_records" ADD CONSTRAINT "kb_sync_records_kb_id_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_sync_records" ADD CONSTRAINT "kb_sync_records_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_sync_kb_idx" ON "kb_sync_records" USING btree ("kb_id");--> statement-breakpoint
CREATE INDEX "kb_sync_file_idx" ON "kb_sync_records" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "kb_sync_status_idx" ON "kb_sync_records" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_sync_kb_file_uq" ON "kb_sync_records" USING btree ("kb_id","file_id");--> statement-breakpoint
CREATE INDEX "agents_run_mode_idx" ON "agents" USING btree ("run_mode");--> statement-breakpoint
CREATE INDEX "kb_platform_lib_idx" ON "knowledge_bases" USING btree ("platform_lib_id");