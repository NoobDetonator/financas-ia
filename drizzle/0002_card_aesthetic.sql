ALTER TABLE `accounts` ADD `debit_card_network` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `debit_card_holder` text;--> statement-breakpoint
ALTER TABLE `credit_cards` ADD `network` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `credit_cards` ADD `holder_label` text;
