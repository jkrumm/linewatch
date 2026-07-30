CREATE TABLE `probe_cycle` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`path_if` text,
	`path_class` text,
	`link_media` text,
	`link_mbit` integer,
	`link_duplex` text,
	`gateway_addr` text,
	`if_ierrs` integer,
	`if_oerrs` integer,
	`if_coll` integer,
	`on_home_line` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `probe_cycle_ts` ON `probe_cycle` (`ts`);--> statement-breakpoint
CREATE TABLE `router_eth_port` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`name` text,
	`alias` text,
	`status` text,
	`max_bit_rate` integer,
	`duplex_mode` text
);
--> statement-breakpoint
CREATE INDEX `router_eth_ts` ON `router_eth_port` (`ts`);--> statement-breakpoint
CREATE TABLE `router_host` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`ip` text,
	`interface_type` text,
	`active` integer,
	`client_type` text,
	`host_name` text
);
--> statement-breakpoint
CREATE INDEX `router_host_ts` ON `router_host` (`ts`);--> statement-breakpoint
CREATE TABLE `router_intf_sample` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`name` text NOT NULL,
	`stack` integer,
	`role` text,
	`rx_kbps` integer,
	`tx_kbps` integer,
	`bytes_rx` integer,
	`bytes_tx` integer
);
--> statement-breakpoint
CREATE INDEX `router_intf_ts` ON `router_intf_sample` (`ts`);--> statement-breakpoint
CREATE INDEX `router_intf_name_ts` ON `router_intf_sample` (`name`,`ts`);--> statement-breakpoint
CREATE TABLE `router_line_sample` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`carrier` text,
	`status` text,
	`down_sync_kbps` integer,
	`up_sync_kbps` integer,
	`down_curr_kbps` integer,
	`up_curr_kbps` integer,
	`down_noise_margin_db` real,
	`up_noise_margin_db` real,
	`down_attenuation_db` real,
	`profile` text,
	`showtime_start_s` integer,
	`errored_secs` integer,
	`severely_errored_secs` integer
);
--> statement-breakpoint
CREATE INDEX `router_line_ts` ON `router_line_sample` (`ts`);