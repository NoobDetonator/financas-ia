ALTER TABLE `accounts` ADD `has_debit_card` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `debit_is_virtual` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `credit_cards` ADD `is_virtual` integer DEFAULT false NOT NULL;
