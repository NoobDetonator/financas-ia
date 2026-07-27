CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`institution` text,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`opening_balance_cents` integer DEFAULT 0 NOT NULL,
	`opening_date` text NOT NULL,
	`color` text,
	`icon` text,
	`notes` text,
	`aliases` text,
	`is_archived` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `accounts_kind_idx` ON `accounts` (`kind`);--> statement-breakpoint
CREATE INDEX `accounts_archived_idx` ON `accounts` (`is_archived`);--> statement-breakpoint
CREATE TABLE `ai_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`message_id` text,
	`tool` text NOT NULL,
	`args` text NOT NULL,
	`risk` text NOT NULL,
	`status` text NOT NULL,
	`change_set_id` text,
	`result` text,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `ai_messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`change_set_id`) REFERENCES `change_sets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_actions_conv_idx` ON `ai_actions` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `ai_actions_status_idx` ON `ai_actions` (`status`);--> statement-breakpoint
CREATE TABLE `ai_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`model` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_messages_seq_unique` ON `ai_messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`filename` text NOT NULL,
	`stored_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_tx_idx` ON `attachments` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`change_set_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`before` text,
	`after` text,
	FOREIGN KEY (`change_set_id`) REFERENCES `change_sets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_changeset_seq_unique` ON `audit_log` (`change_set_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`start_month` text NOT NULL,
	`end_month` text,
	`rollover` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `budgets_category_idx` ON `budgets` (`category_id`,`start_month`);--> statement-breakpoint
CREATE TABLE `card_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`card_account_id` text NOT NULL,
	`reference_month` text NOT NULL,
	`closing_date` text NOT NULL,
	`due_date` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`paid_cents` integer DEFAULT 0 NOT NULL,
	`payment_transaction_id` text,
	`closed_at` text,
	`paid_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`card_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_card_month_unique` ON `card_invoices` (`card_account_id`,`reference_month`);--> statement-breakpoint
CREATE INDEX `invoice_due_idx` ON `card_invoices` (`due_date`);--> statement-breakpoint
CREATE INDEX `invoice_status_idx` ON `card_invoices` (`status`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`color` text,
	`icon` text,
	`is_system` integer DEFAULT false NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE INDEX `categories_kind_idx` ON `categories` (`kind`);--> statement-breakpoint
CREATE TABLE `change_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`actor` text NOT NULL,
	`summary` text NOT NULL,
	`status` text DEFAULT 'applied' NOT NULL,
	`risk` text DEFAULT 'auto' NOT NULL,
	`tool` text,
	`preview` text,
	`revert_of` text,
	`conversation_id` text,
	`request_id` text,
	`created_at` text NOT NULL,
	`applied_at` text,
	`reverted_at` text
);
--> statement-breakpoint
CREATE INDEX `change_sets_status_idx` ON `change_sets` (`status`);--> statement-breakpoint
CREATE INDEX `change_sets_created_idx` ON `change_sets` (`created_at`);--> statement-breakpoint
CREATE INDEX `change_sets_revert_idx` ON `change_sets` (`revert_of`);--> statement-breakpoint
CREATE TABLE `credit_cards` (
	`account_id` text PRIMARY KEY NOT NULL,
	`limit_cents` integer DEFAULT 0 NOT NULL,
	`closing_day` integer NOT NULL,
	`due_day` integer NOT NULL,
	`payment_account_id` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payment_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `debt_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`debt_id` text NOT NULL,
	`transaction_id` text,
	`installment_no` integer NOT NULL,
	`due_date` text NOT NULL,
	`paid_date` text,
	`amount_cents` integer NOT NULL,
	`principal_cents` integer NOT NULL,
	`interest_cents` integer NOT NULL,
	`balance_after_cents` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`debt_id`) REFERENCES `debts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `debt_payment_no_unique` ON `debt_payments` (`debt_id`,`installment_no`);--> statement-breakpoint
CREATE INDEX `debt_payment_due_idx` ON `debt_payments` (`due_date`);--> statement-breakpoint
CREATE TABLE `debts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'loan' NOT NULL,
	`principal_cents` integer NOT NULL,
	`annual_rate_bps` integer DEFAULT 0 NOT NULL,
	`term_months` integer NOT NULL,
	`system` text DEFAULT 'price' NOT NULL,
	`start_date` text NOT NULL,
	`first_due_date` text NOT NULL,
	`account_id` text,
	`category_id` text,
	`is_settled` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `debts_settled_idx` ON `debts` (`is_settled`);--> statement-breakpoint
CREATE TABLE `goal_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`transaction_id` text,
	`amount_cents` integer NOT NULL,
	`date` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `goal_contrib_goal_idx` ON `goal_contributions` (`goal_id`,`date`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`target_cents` integer NOT NULL,
	`target_date` text,
	`account_id` text,
	`color` text,
	`icon` text,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `goals_status_idx` ON `goals` (`status`);--> statement-breakpoint
CREATE TABLE `holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ticker` text,
	`asset_class` text DEFAULT 'other' NOT NULL,
	`account_id` text,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`quantity_e_8` integer DEFAULT 0 NOT NULL,
	`total_cost_cents` integer DEFAULT 0 NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `holdings_class_idx` ON `holdings` (`asset_class`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`filename` text NOT NULL,
	`account_id` text NOT NULL,
	`file_hash` text NOT NULL,
	`status` text DEFAULT 'parsed' NOT NULL,
	`stats` text,
	`change_set_id` text,
	`created_at` text NOT NULL,
	`applied_at` text,
	`reverted_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `import_batch_account_idx` ON `import_batches` (`account_id`);--> statement-breakpoint
CREATE INDEX `import_batch_hash_idx` ON `import_batches` (`file_hash`);--> statement-breakpoint
CREATE TABLE `import_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`raw` text NOT NULL,
	`parsed` text,
	`dedupe_hash` text,
	`status` text DEFAULT 'new' NOT NULL,
	`transaction_id` text,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `import_rows_batch_idx` ON `import_rows` (`batch_id`);--> statement-breakpoint
CREATE INDEX `import_rows_dedupe_idx` ON `import_rows` (`dedupe_hash`);--> statement-breakpoint
CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`period` text,
	`title` text NOT NULL,
	`data` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`detected_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insights_fingerprint_unique` ON `insights` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `insights_status_idx` ON `insights` (`status`,`severity`);--> statement-breakpoint
CREATE TABLE `installment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`description` text NOT NULL,
	`total_cents` integer NOT NULL,
	`installments` integer NOT NULL,
	`purchase_date` text NOT NULL,
	`first_charge_date` text NOT NULL,
	`category_id` text,
	`payee_id` text,
	`notes` text,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payee_id`) REFERENCES `payees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `plans_account_idx` ON `installment_plans` (`account_id`);--> statement-breakpoint
CREATE TABLE `investment_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`holding_id` text NOT NULL,
	`op` text NOT NULL,
	`date` text NOT NULL,
	`quantity_e_8` integer DEFAULT 0 NOT NULL,
	`amount_cents` integer NOT NULL,
	`fee_cents` integer DEFAULT 0 NOT NULL,
	`transaction_id` text,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`holding_id`) REFERENCES `holdings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `inv_tx_holding_idx` ON `investment_transactions` (`holding_id`,`date`);--> statement-breakpoint
CREATE TABLE `payees` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`default_category_id` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`default_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payees_normalized_unique` ON `payees` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `position_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`holding_id` text NOT NULL,
	`date` text NOT NULL,
	`market_value_cents` integer NOT NULL,
	`quantity_e_8` integer NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`holding_id`) REFERENCES `holdings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshot_holding_date_unique` ON `position_snapshots` (`holding_id`,`date`);--> statement-breakpoint
CREATE TABLE `recurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`account_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_cents` integer,
	`estimated_cents` integer,
	`category_id` text,
	`payee_id` text,
	`freq` text NOT NULL,
	`interval` integer DEFAULT 1 NOT NULL,
	`day_of_month` integer,
	`weekday` integer,
	`month` integer,
	`start_date` text NOT NULL,
	`end_date` text,
	`max_occurrences` integer,
	`auto_post` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`materialized_through` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payee_id`) REFERENCES `payees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recurrences_active_idx` ON `recurrences` (`is_active`);--> statement-breakpoint
CREATE INDEX `recurrences_account_idx` ON `recurrences` (`account_id`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`body_md` text NOT NULL,
	`insight_ids` text,
	`model` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reports_period_idx` ON `reports` (`period_start`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`stop_on_match` integer DEFAULT true NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`match_count` integer DEFAULT 0 NOT NULL,
	`last_matched_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rules_enabled_priority_idx` ON `rules` (`is_enabled`,`priority`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`timezone` text DEFAULT 'America/Sao_Paulo' NOT NULL,
	`locale` text DEFAULT 'pt-BR' NOT NULL,
	`ai_model` text DEFAULT 'deepseek-chat' NOT NULL,
	`ai_confirm_amount_cents` integer DEFAULT 50000 NOT NULL,
	`ai_confirm_bulk_rows` integer DEFAULT 5 NOT NULL,
	`projection_horizon_days` integer DEFAULT 90 NOT NULL,
	`materialize_horizon_days` integer DEFAULT 120 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`color` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_normalized_unique` ON `tags` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `transaction_splits` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`category_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `splits_tx_idx` ON `transaction_splits` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `transaction_tags` (
	`transaction_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`transaction_id`, `tag_id`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tx_tags_tag_idx` ON `transaction_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`type` text NOT NULL,
	`date` text NOT NULL,
	`posted_date` text,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`description` text NOT NULL,
	`notes` text,
	`category_id` text,
	`payee_id` text,
	`status` text DEFAULT 'cleared' NOT NULL,
	`transfer_id` text,
	`has_splits` integer DEFAULT false NOT NULL,
	`installment_plan_id` text,
	`installment_no` integer,
	`recurrence_id` text,
	`recurrence_occurrence` text,
	`card_invoice_id` text,
	`goal_id` text,
	`debt_id` text,
	`import_row_id` text,
	`dedupe_hash` text,
	`external_id` text,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payee_id`) REFERENCES `payees`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`installment_plan_id`) REFERENCES `installment_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recurrence_id`) REFERENCES `recurrences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`card_invoice_id`) REFERENCES `card_invoices`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`debt_id`) REFERENCES `debts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tx_account_date_idx` ON `transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `tx_date_idx` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `tx_category_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `tx_payee_idx` ON `transactions` (`payee_id`);--> statement-breakpoint
CREATE INDEX `tx_status_idx` ON `transactions` (`status`);--> statement-breakpoint
CREATE INDEX `tx_transfer_idx` ON `transactions` (`transfer_id`);--> statement-breakpoint
CREATE INDEX `tx_invoice_idx` ON `transactions` (`card_invoice_id`);--> statement-breakpoint
CREATE INDEX `tx_plan_idx` ON `transactions` (`installment_plan_id`);--> statement-breakpoint
CREATE INDEX `tx_dedupe_idx` ON `transactions` (`dedupe_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `tx_recurrence_occurrence_unique` ON `transactions` (`recurrence_id`,`recurrence_occurrence`);