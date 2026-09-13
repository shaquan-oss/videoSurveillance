CREATE TABLE "kb_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kb_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "kb_folders" ADD CONSTRAINT "kb_folders_kb_id_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_folders" ADD CONSTRAINT "kb_folders_parent_id_kb_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."kb_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_folders_kb_idx" ON "kb_folders" USING btree ("kb_id");--> statement-breakpoint
CREATE INDEX "kb_folders_parent_idx" ON "kb_folders" USING btree ("parent_id");