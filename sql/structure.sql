-- Aplicar ao banco selecionado na conexão. Para bancos existentes, use npm run db:migrate.
-- Snapshot gerado das migrations 001-020 (fonte da verdade: sql/migrations). Sem dados nem schema_migrations.
-- MariaDB dump 10.19-11.4.13-MariaDB, for debian-linux-gnu (x86_64)
--
-- Host: localhost    Database: agendaspro_db
-- ------------------------------------------------------
-- Server version	11.4.13-MariaDB-ubu2404

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;

--
-- Table structure for table `accounts_receivable`
--

DROP TABLE IF EXISTS `accounts_receivable`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `accounts_receivable` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `customer_id` int(11) DEFAULT NULL,
  `due_date` date DEFAULT NULL,
  `status` varchar(10) NOT NULL DEFAULT 'EM ABERTO',
  `observations` text DEFAULT NULL,
  `sale_id` int(11) DEFAULT NULL,
  `amount` decimal(12,2) NOT NULL,
  `payment_type` varchar(50) DEFAULT NULL,
  `receive_date` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `customer_id` (`customer_id`),
  KEY `fk_receivable_sale` (`sale_id`),
  CONSTRAINT `accounts_receivable_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_receivable_sale` FOREIGN KEY (`sale_id`) REFERENCES `sales` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `ai_budget_counters`
--

DROP TABLE IF EXISTS `ai_budget_counters`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_budget_counters` (
  `scope` varchar(16) NOT NULL,
  `scope_key` varchar(80) NOT NULL,
  `day` date NOT NULL,
  `tokens` bigint(20) NOT NULL DEFAULT 0,
  `cost_micro_usd` bigint(20) NOT NULL DEFAULT 0,
  `calls` int(11) NOT NULL DEFAULT 0,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`scope`,`scope_key`,`day`),
  KEY `idx_ai_budget_day` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `ai_circuit`
--

DROP TABLE IF EXISTS `ai_circuit`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_circuit` (
  `name` varchar(40) NOT NULL,
  `failures` int(11) NOT NULL DEFAULT 0,
  `opened_until_ms` bigint(20) NOT NULL DEFAULT 0,
  `reason` varchar(40) DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `ai_usage`
--

DROP TABLE IF EXISTS `ai_usage`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_usage` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) DEFAULT NULL,
  `session_id` bigint(20) DEFAULT NULL,
  `feature` varchar(40) NOT NULL,
  `provider` varchar(20) NOT NULL,
  `model` varchar(80) NOT NULL,
  `tokens_in` int(11) NOT NULL DEFAULT 0,
  `tokens_out` int(11) NOT NULL DEFAULT 0,
  `cost_micro_usd` bigint(20) NOT NULL DEFAULT 0,
  `status` enum('ok','error','timeout','invalid','blocked') NOT NULL DEFAULT 'ok',
  `latency_ms` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_ai_usage_company` (`company_id`,`created_at`),
  KEY `idx_ai_usage_session` (`session_id`),
  KEY `idx_ai_usage_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `ai_usage_daily`
--

DROP TABLE IF EXISTS `ai_usage_daily`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_usage_daily` (
  `company_id` int(11) NOT NULL,
  `day` date NOT NULL,
  `tokens_used` int(11) NOT NULL DEFAULT 0,
  `calls` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`company_id`,`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `appointment_services`
--

DROP TABLE IF EXISTS `appointment_services`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `appointment_services` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `service_id` int(11) NOT NULL,
  `appointment_id` int(11) NOT NULL,
  `quantity` int(11) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `FK_appointment_services_service_id` (`service_id`),
  KEY `FK_appointment_services_appointment_id` (`appointment_id`),
  CONSTRAINT `FK_appointment_services_appointment_id` FOREIGN KEY (`appointment_id`) REFERENCES `appointments` (`id`),
  CONSTRAINT `FK_appointment_services_service_id` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Temporary table structure for view `appointment_status_view`
--

DROP TABLE IF EXISTS `appointment_status_view`;
/*!50001 DROP VIEW IF EXISTS `appointment_status_view`*/;
SET @saved_cs_client     = @@character_set_client;
SET character_set_client = utf8mb4;
/*!50001 CREATE VIEW `appointment_status_view` AS SELECT
 NULL AS `id`,
 NULL AS `customer_id`,
 NULL AS `customer_name`,
 NULL AS `date`,
 NULL AS `duration`,
 NULL AS `observations`,
 NULL AS `company_id`,
 NULL AS `checkin`,
 NULL AS `checkout`,
 NULL AS `canceled`,
 NULL AS `zip_code`,
 NULL AS `address`,
 NULL AS `number`,
 NULL AS `complement`,
 NULL AS `city`,
 NULL AS `state`,
 NULL AS `notified_1h`,
 NULL AS `payment_status`,
 NULL AS `professional_id`,
 NULL AS `notified_2h`,
 NULL AS `hold_expires_at`,
 NULL AS `source`,
 NULL AS `status` */;
SET character_set_client = @saved_cs_client;

--
-- Table structure for table `appointments`
--

DROP TABLE IF EXISTS `appointments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `appointments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `customer_id` int(11) NOT NULL,
  `customer_name` varchar(255) NOT NULL,
  `date` datetime NOT NULL,
  `duration` int(11) NOT NULL,
  `observations` text DEFAULT NULL,
  `company_id` int(11) NOT NULL,
  `checkin` datetime DEFAULT NULL,
  `checkout` datetime DEFAULT NULL,
  `canceled` int(11) NOT NULL DEFAULT 0,
  `zip_code` varchar(10) DEFAULT NULL,
  `address` varchar(255) DEFAULT NULL,
  `number` varchar(20) DEFAULT NULL,
  `complement` varchar(100) DEFAULT NULL,
  `city` varchar(100) DEFAULT NULL,
  `state` varchar(2) DEFAULT NULL,
  `notified_1h` tinyint(1) DEFAULT 0,
  `payment_status` varchar(20) DEFAULT 'isento',
  `professional_id` int(11) DEFAULT NULL,
  `notified_2h` tinyint(1) NOT NULL DEFAULT 0,
  `hold_expires_at` datetime DEFAULT NULL,
  `source` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_appointments_customer_id` (`customer_id`),
  KEY `FK_appointments_company_id` (`company_id`),
  KEY `idx_appointments_reminder` (`notified_1h`,`canceled`,`date`),
  KEY `idx_appointments_professional` (`company_id`,`professional_id`,`date`),
  KEY `idx_appointments_reminder_2h` (`notified_2h`,`canceled`,`date`),
  KEY `fk_appointments_professional` (`professional_id`),
  KEY `idx_appointments_hold` (`company_id`,`hold_expires_at`),
  CONSTRAINT `FK_appointments_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `FK_appointments_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_appointments_professional` FOREIGN KEY (`professional_id`) REFERENCES `professionals` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `asaas_wallets`
--

DROP TABLE IF EXISTS `asaas_wallets`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `asaas_wallets` (
  `document` varchar(20) NOT NULL,
  `asaas_api_key` text NOT NULL,
  `asaas_wallet_id` varchar(100) NOT NULL,
  `asaas_status` varchar(20) DEFAULT 'PENDING',
  `owner_user_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`document`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `assistant_actions`
--

DROP TABLE IF EXISTS `assistant_actions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `assistant_actions` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `public_id` char(32) NOT NULL,
  `company_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `conversation_id` bigint(20) DEFAULT NULL,
  `tool` varchar(40) NOT NULL,
  `risk` enum('low','medium','high') NOT NULL DEFAULT 'medium',
  `summary` varchar(300) NOT NULL,
  `params` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`params`)),
  `payload_hash` char(64) NOT NULL,
  `token_version` int(11) NOT NULL DEFAULT 0,
  `status` enum('pending','executing','executed','failed','rejected','expired') NOT NULL DEFAULT 'pending',
  `expires_at_ms` bigint(20) NOT NULL,
  `result` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`result`)),
  `error_message` varchar(300) DEFAULT NULL,
  `executed_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_assistant_action_public` (`public_id`),
  KEY `idx_assistant_action_owner` (`company_id`,`user_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `assistant_audit`
--

DROP TABLE IF EXISTS `assistant_audit`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `assistant_audit` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `conversation_id` bigint(20) DEFAULT NULL,
  `action_id` bigint(20) DEFAULT NULL,
  `event` varchar(30) NOT NULL,
  `tool` varchar(40) DEFAULT NULL,
  `params` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`params`)),
  `result` varchar(40) DEFAULT NULL,
  `detail` varchar(300) DEFAULT NULL,
  `tokens` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_assistant_audit_company` (`company_id`,`created_at`),
  KEY `idx_assistant_audit_action` (`action_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `assistant_conversations`
--

DROP TABLE IF EXISTS `assistant_conversations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `assistant_conversations` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `public_id` char(32) NOT NULL,
  `company_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `title` varchar(120) DEFAULT NULL,
  `summary` text DEFAULT NULL,
  `message_count` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_assistant_conv_public` (`public_id`),
  KEY `idx_assistant_conv_owner` (`company_id`,`user_id`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `assistant_embeddings`
--

DROP TABLE IF EXISTS `assistant_embeddings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `assistant_embeddings` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `source_type` varchar(24) NOT NULL,
  `source_id` bigint(20) NOT NULL,
  `chunk` smallint(6) NOT NULL DEFAULT 0,
  `content_hash` char(64) NOT NULL,
  `model` varchar(80) NOT NULL,
  `dims` smallint(6) NOT NULL,
  `content` text NOT NULL,
  `vector` mediumblob NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_assistant_emb_source` (`company_id`,`source_type`,`source_id`,`chunk`),
  KEY `idx_assistant_emb_company` (`company_id`),
  KEY `idx_assistant_emb_hash` (`company_id`,`content_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `assistant_knowledge`
--

DROP TABLE IF EXISTS `assistant_knowledge`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `assistant_knowledge` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `kind` enum('faq','policy','rule','template') NOT NULL DEFAULT 'faq',
  `title` varchar(160) NOT NULL,
  `content` text NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_assistant_knowledge_company` (`company_id`,`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `assistant_messages`
--

DROP TABLE IF EXISTS `assistant_messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `assistant_messages` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `conversation_id` bigint(20) NOT NULL,
  `company_id` int(11) NOT NULL,
  `role` enum('user','assistant') NOT NULL,
  `content` text NOT NULL,
  `intent` varchar(40) DEFAULT NULL,
  `source` enum('user','template','ai','fallback') NOT NULL DEFAULT 'user',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_assistant_msg_conv` (`conversation_id`,`id`),
  KEY `idx_assistant_msg_company` (`company_id`,`created_at`),
  CONSTRAINT `fk_assistant_msg_conv` FOREIGN KEY (`conversation_id`) REFERENCES `assistant_conversations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `availability_rules`
--

DROP TABLE IF EXISTS `availability_rules`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `availability_rules` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `professional_id` int(11) NOT NULL,
  `weekday` tinyint(4) NOT NULL,
  `start_time` time NOT NULL,
  `end_time` time NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_availability_rules_company` (`company_id`),
  KEY `idx_availability_rules_professional` (`professional_id`,`weekday`),
  CONSTRAINT `fk_availability_rules_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_availability_rules_professional` FOREIGN KEY (`professional_id`) REFERENCES `professionals` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_availability_rules` CHECK (`weekday` between 0 and 6 and `end_time` > `start_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `booking_attributions`
--

DROP TABLE IF EXISTS `booking_attributions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `booking_attributions` (
  `appointment_id` int(11) NOT NULL,
  `company_id` int(11) NOT NULL,
  `utm_source` varchar(40) NOT NULL DEFAULT '',
  `utm_medium` varchar(40) NOT NULL DEFAULT '',
  `utm_campaign` varchar(80) NOT NULL DEFAULT '',
  `utm_content` varchar(80) NOT NULL DEFAULT '',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`appointment_id`),
  KEY `idx_booking_attributions_company` (`company_id`,`utm_source`,`created_at`),
  CONSTRAINT `fk_booking_attributions_appointment` FOREIGN KEY (`appointment_id`) REFERENCES `appointments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_booking_attributions_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `business_types`
--

DROP TABLE IF EXISTS `business_types`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `business_types` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `chat_messages`
--

DROP TABLE IF EXISTS `chat_messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_messages` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `session_id` bigint(20) NOT NULL,
  `role` enum('user','assistant') NOT NULL,
  `content` text NOT NULL,
  `client_msg_id` varchar(64) DEFAULT NULL,
  `reply_to_id` bigint(20) DEFAULT NULL,
  `source` varchar(20) DEFAULT NULL,
  `intent` varchar(40) DEFAULT NULL,
  `payload` text DEFAULT NULL,
  `tokens_in` int(11) NOT NULL DEFAULT 0,
  `tokens_out` int(11) NOT NULL DEFAULT 0,
  `flagged` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_chat_messages_client` (`session_id`,`client_msg_id`),
  KEY `idx_chat_messages_session` (`session_id`,`id`),
  KEY `idx_chat_messages_reply` (`reply_to_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `chat_sessions`
--

DROP TABLE IF EXISTS `chat_sessions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_sessions` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `public_id` varchar(32) NOT NULL,
  `audience` enum('customer','business') NOT NULL,
  `company_id` int(11) DEFAULT NULL,
  `ip_hash` char(64) NOT NULL,
  `status` enum('active','closed','blocked') NOT NULL DEFAULT 'active',
  `message_count` int(11) NOT NULL DEFAULT 0,
  `tokens_used` int(11) NOT NULL DEFAULT 0,
  `max_messages` int(11) NOT NULL,
  `max_tokens` int(11) NOT NULL,
  `injection_strikes` int(11) NOT NULL DEFAULT 0,
  `blocked_until_ms` bigint(20) NOT NULL DEFAULT 0,
  `last_user_at_ms` bigint(20) NOT NULL DEFAULT 0,
  `summary` varchar(500) DEFAULT NULL,
  `lead_captured_at` datetime DEFAULT NULL,
  `rating` tinyint(4) DEFAULT NULL,
  `rating_comment` varchar(500) DEFAULT NULL,
  `expires_at_ms` bigint(20) NOT NULL,
  `renewed_until_ms` bigint(20) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `closed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_chat_sessions_public` (`public_id`),
  KEY `idx_chat_sessions_company` (`company_id`,`created_at`),
  KEY `idx_chat_sessions_ip` (`ip_hash`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `companies`
--

DROP TABLE IF EXISTS `companies`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `companies` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `address` varchar(255) NOT NULL,
  `city` varchar(100) DEFAULT NULL,
  `state` varchar(2) DEFAULT NULL,
  `business_type` int(11) DEFAULT NULL,
  `zip_code` varchar(9) DEFAULT NULL,
  `document` varchar(20) DEFAULT NULL,
  `email` varchar(100) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `address_number` varchar(20) DEFAULT NULL,
  `complement` varchar(100) DEFAULT NULL,
  `asaas_wallet_id` varchar(255) DEFAULT NULL,
  `asaas_api_key` text DEFAULT NULL,
  `asaas_status` varchar(20) NOT NULL DEFAULT 'PENDING',
  `timezone` varchar(64) DEFAULT NULL,
  `slug` varchar(60) DEFAULT NULL,
  `public_page_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `public_description` varchar(600) DEFAULT NULL,
  `logo_url` varchar(500) DEFAULT NULL,
  `instagram_url` varchar(255) DEFAULT NULL,
  `public_hours` varchar(255) DEFAULT NULL,
  `theme_primary_color` varchar(7) DEFAULT NULL,
  `booking_min_notice_minutes` int(11) NOT NULL DEFAULT 120,
  `booking_cancel_notice_minutes` int(11) NOT NULL DEFAULT 120,
  `booking_hold_minutes` int(11) NOT NULL DEFAULT 15,
  `booking_slot_step_minutes` int(11) NOT NULL DEFAULT 30,
  `booking_horizon_days` int(11) NOT NULL DEFAULT 60,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_companies_slug` (`slug`),
  KEY `FK_companies_business_type` (`business_type`),
  CONSTRAINT `FK_companies_business_type` FOREIGN KEY (`business_type`) REFERENCES `business_types` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `company_invitations`
--

DROP TABLE IF EXISTS `company_invitations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `company_invitations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `invited_by` int(11) NOT NULL,
  `invitation_date` datetime DEFAULT current_timestamp(),
  `status` enum('pending','accepted','declined') DEFAULT 'pending',
  `invited_user` varchar(255) NOT NULL,
  `token` varchar(50) DEFAULT NULL,
  `role_id` int(11) NOT NULL,
  `token_hash` char(64) DEFAULT NULL,
  `expires_at` datetime DEFAULT NULL,
  `used_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_invitations_company` (`company_id`),
  KEY `FK_company_invitatios_role_id` (`role_id`),
  KEY `FK_company_invitations_user_email` (`invited_user`),
  KEY `idx_company_invitations_token_hash` (`token_hash`),
  CONSTRAINT `FK_company_invitatios_role_id` FOREIGN KEY (`role_id`) REFERENCES `config_company_roles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_invitations_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `company_members`
--

DROP TABLE IF EXISTS `company_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `company_members` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `company_id` int(11) NOT NULL,
  `joined_date` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `FK_company_members_user` (`user_id`),
  KEY `FK_company_members_company` (`company_id`),
  CONSTRAINT `FK_company_members_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_company_members_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `company_subscriptions`
--

DROP TABLE IF EXISTS `company_subscriptions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `company_subscriptions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `plan_id` int(11) NOT NULL,
  `status` enum('pending','active','canceled') NOT NULL DEFAULT 'pending',
  `billing_type` varchar(20) NOT NULL DEFAULT 'UNDEFINED',
  `price_cents` int(11) NOT NULL,
  `provider` varchar(20) NOT NULL DEFAULT 'asaas',
  `provider_customer_id` varchar(100) DEFAULT NULL,
  `provider_subscription_id` varchar(100) DEFAULT NULL,
  `next_due_date` date DEFAULT NULL,
  `canceled_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_company_subscriptions_company` (`company_id`),
  UNIQUE KEY `uq_company_subscriptions_provider` (`provider_subscription_id`),
  KEY `fk_company_subscriptions_plan` (`plan_id`),
  CONSTRAINT `fk_company_subscriptions_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_company_subscriptions_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_companies_preferences`
--

DROP TABLE IF EXISTS `config_companies_preferences`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `config_companies_preferences` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `preference_id` int(11) NOT NULL,
  `active` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_config_companies_preferences_preference_id` (`preference_id`),
  KEY `FK_config_companies_preferences_company_id` (`company_id`),
  CONSTRAINT `FK_config_companies_preferences_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_config_companies_preferences_preference_id` FOREIGN KEY (`preference_id`) REFERENCES `preferences` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_companies_schedule`
--

DROP TABLE IF EXISTS `config_companies_schedule`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `config_companies_schedule` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `day` int(11) NOT NULL,
  `initial_date` varchar(5) NOT NULL,
  `final_date` varchar(5) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_config_companies_schedule_company_id` (`company_id`),
  CONSTRAINT `FK_config_companies_schedule_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_company_roles`
--

DROP TABLE IF EXISTS `config_company_roles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `config_company_roles` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(50) NOT NULL,
  `company_id` int(11) NOT NULL,
  `permission` int(11) NOT NULL DEFAULT 0,
  `create_date` datetime NOT NULL DEFAULT current_timestamp(),
  `default_role` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `FK_config_company_roles_company_id` (`company_id`),
  CONSTRAINT `FK_config_company_roles_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_notifications`
--

DROP TABLE IF EXISTS `config_notifications`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `config_notifications` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `active` int(11) NOT NULL,
  `company` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `company` (`company`),
  CONSTRAINT `config_notifications_ibfk_1` FOREIGN KEY (`company`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_opening_hours`
--

DROP TABLE IF EXISTS `config_opening_hours`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `config_opening_hours` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `day` varchar(20) NOT NULL,
  `initial_date` time NOT NULL,
  `final_date` time NOT NULL,
  `company` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `company` (`company`),
  CONSTRAINT `config_opening_hours_ibfk_1` FOREIGN KEY (`company`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_users_roles`
--

DROP TABLE IF EXISTS `config_users_roles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `config_users_roles` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `role_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `assignment_date` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `FK_config_users_roles_user_id` (`user_id`),
  KEY `FK_config_users_roles_role_id` (`role_id`),
  CONSTRAINT `FK_config_users_roles_role_id` FOREIGN KEY (`role_id`) REFERENCES `config_company_roles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_config_users_roles_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `consents`
--

DROP TABLE IF EXISTS `consents`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `consents` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `customer_id` int(11) NOT NULL,
  `purpose` varchar(50) NOT NULL,
  `granted` tinyint(1) NOT NULL DEFAULT 1,
  `source` varchar(30) DEFAULT NULL,
  `granted_at` datetime NOT NULL DEFAULT current_timestamp(),
  `revoked_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_consents_company_customer` (`company_id`,`customer_id`),
  KEY `fk_consents_customer` (`customer_id`),
  CONSTRAINT `fk_consents_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_consents_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `customers`
--

DROP TABLE IF EXISTS `customers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `customers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `birthday` datetime DEFAULT NULL,
  `tel` varchar(20) DEFAULT NULL,
  `image` varchar(255) DEFAULT NULL,
  `company_id` int(11) NOT NULL,
  `cpf` varchar(14) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `anonymized_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_customers_company_id` (`company_id`),
  KEY `IDX_name` (`name`),
  CONSTRAINT `FK_customers_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `google_calendar_accounts`
--

DROP TABLE IF EXISTS `google_calendar_accounts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `google_calendar_accounts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `account_email` varchar(255) DEFAULT NULL,
  `refresh_token_enc` text DEFAULT NULL,
  `access_token_enc` text DEFAULT NULL,
  `access_expires_at` datetime DEFAULT NULL,
  `scopes` varchar(500) DEFAULT NULL,
  `status` enum('active','reauth_required') NOT NULL DEFAULT 'active',
  `last_error_code` varchar(60) DEFAULT NULL,
  `connected_by_user_id` int(11) DEFAULT NULL,
  `connected_at` datetime NOT NULL DEFAULT current_timestamp(),
  `last_push_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_gcal_accounts_company` (`company_id`),
  CONSTRAINT `fk_gcal_accounts_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `google_calendar_events`
--

DROP TABLE IF EXISTS `google_calendar_events`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `google_calendar_events` (
  `company_id` int(11) NOT NULL,
  `appointment_id` int(11) NOT NULL,
  `link_id` int(11) DEFAULT NULL,
  `calendar_id` varchar(190) NOT NULL,
  `event_id` varchar(64) NOT NULL,
  `content_hash` char(64) DEFAULT NULL,
  `status` enum('synced','deleted') NOT NULL DEFAULT 'synced',
  `synced_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`company_id`,`appointment_id`),
  KEY `idx_gcal_events_event` (`event_id`),
  CONSTRAINT `fk_gcal_events_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `google_calendar_links`
--

DROP TABLE IF EXISTS `google_calendar_links`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `google_calendar_links` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `role` enum('push','busy') NOT NULL,
  `professional_id` int(11) DEFAULT NULL,
  `pro_key` int(11) GENERATED ALWAYS AS (coalesce(`professional_id`,0)) STORED,
  `calendar_id` varchar(190) NOT NULL,
  `calendar_summary` varchar(255) DEFAULT NULL,
  `created_by_app` tinyint(1) NOT NULL DEFAULT 0,
  `sync_token` text DEFAULT NULL,
  `last_sync_at` datetime DEFAULT NULL,
  `last_full_sync_at` datetime DEFAULT NULL,
  `channel_id` varchar(64) DEFAULT NULL,
  `channel_token_hash` char(64) DEFAULT NULL,
  `channel_resource_id` varchar(255) DEFAULT NULL,
  `channel_expires_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_gcal_links` (`company_id`,`role`,`pro_key`,`calendar_id`),
  UNIQUE KEY `uq_gcal_links_channel` (`channel_id`),
  KEY `idx_gcal_links_account` (`account_id`),
  KEY `fk_gcal_links_professional` (`professional_id`),
  CONSTRAINT `fk_gcal_links_account` FOREIGN KEY (`account_id`) REFERENCES `google_calendar_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_gcal_links_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_gcal_links_professional` FOREIGN KEY (`professional_id`) REFERENCES `professionals` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `inbound_events`
--

DROP TABLE IF EXISTS `inbound_events`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `inbound_events` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `provider` varchar(30) NOT NULL,
  `external_id` varchar(191) NOT NULL,
  `event_type` varchar(100) DEFAULT NULL,
  `payload` longtext DEFAULT NULL,
  `status` enum('received','processed','failed','ignored') NOT NULL DEFAULT 'received',
  `attempts` int(11) NOT NULL DEFAULT 0,
  `last_error` varchar(500) DEFAULT NULL,
  `received_at` datetime NOT NULL DEFAULT current_timestamp(),
  `processed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inbound_events_external` (`provider`,`external_id`),
  KEY `idx_inbound_events_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `instagram_accounts`
--

DROP TABLE IF EXISTS `instagram_accounts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `instagram_accounts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `ig_user_id` varchar(64) NOT NULL,
  `app_user_id` varchar(64) DEFAULT NULL,
  `username` varchar(100) DEFAULT NULL,
  `name` varchar(150) DEFAULT NULL,
  `account_type` varchar(30) DEFAULT NULL,
  `profile_picture_url` varchar(1000) DEFAULT NULL,
  `followers_count` int(11) DEFAULT NULL,
  `follows_count` int(11) DEFAULT NULL,
  `media_count` int(11) DEFAULT NULL,
  `access_token_enc` text DEFAULT NULL,
  `token_expires_at` datetime DEFAULT NULL,
  `token_refreshed_at` datetime DEFAULT NULL,
  `scopes` varchar(500) DEFAULT NULL,
  `status` enum('active','reauth_required') NOT NULL DEFAULT 'active',
  `last_error_code` varchar(60) DEFAULT NULL,
  `rate_limited_until` datetime DEFAULT NULL,
  `connected_by_user_id` int(11) DEFAULT NULL,
  `connected_at` datetime NOT NULL DEFAULT current_timestamp(),
  `profile_synced_at` datetime DEFAULT NULL,
  `media_synced_at` datetime DEFAULT NULL,
  `insights_synced_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_instagram_accounts_company` (`company_id`),
  KEY `idx_instagram_accounts_ig_user` (`ig_user_id`),
  KEY `idx_instagram_accounts_app_user` (`app_user_id`),
  KEY `idx_instagram_accounts_token` (`status`,`token_expires_at`),
  CONSTRAINT `fk_instagram_accounts_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `instagram_deletion_requests`
--

DROP TABLE IF EXISTS `instagram_deletion_requests`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `instagram_deletion_requests` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `confirmation_code` char(22) NOT NULL,
  `user_hash` char(64) NOT NULL,
  `kind` enum('deletion','deauthorize') NOT NULL,
  `accounts_removed` int(11) NOT NULL DEFAULT 0,
  `status` enum('completed') NOT NULL DEFAULT 'completed',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_instagram_deletion_code` (`confirmation_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `instagram_media`
--

DROP TABLE IF EXISTS `instagram_media`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `instagram_media` (
  `company_id` int(11) NOT NULL,
  `media_id` varchar(64) NOT NULL,
  `caption` varchar(2200) DEFAULT NULL,
  `media_type` varchar(30) DEFAULT NULL,
  `media_product_type` varchar(30) DEFAULT NULL,
  `permalink` varchar(500) DEFAULT NULL,
  `thumbnail_url` varchar(1000) DEFAULT NULL,
  `posted_at` datetime DEFAULT NULL,
  `like_count` int(11) DEFAULT NULL,
  `comments_count` int(11) DEFAULT NULL,
  `reach` int(11) DEFAULT NULL,
  `views` int(11) DEFAULT NULL,
  `saved` int(11) DEFAULT NULL,
  `shares` int(11) DEFAULT NULL,
  `total_interactions` int(11) DEFAULT NULL,
  `insights_at` datetime DEFAULT NULL,
  `fetched_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`company_id`,`media_id`),
  KEY `idx_instagram_media_posted` (`company_id`,`posted_at`),
  CONSTRAINT `fk_instagram_media_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `instagram_snapshots`
--

DROP TABLE IF EXISTS `instagram_snapshots`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `instagram_snapshots` (
  `company_id` int(11) NOT NULL,
  `snapshot_date` date NOT NULL,
  `followers_count` int(11) DEFAULT NULL,
  `follows_count` int(11) DEFAULT NULL,
  `media_count` int(11) DEFAULT NULL,
  `reach` int(11) DEFAULT NULL,
  `views` int(11) DEFAULT NULL,
  `accounts_engaged` int(11) DEFAULT NULL,
  `total_interactions` int(11) DEFAULT NULL,
  `profile_links_taps` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`company_id`,`snapshot_date`),
  CONSTRAINT `fk_instagram_snapshots_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `jobs`
--

DROP TABLE IF EXISTS `jobs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `jobs` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `type` varchar(100) NOT NULL,
  `payload` longtext DEFAULT NULL,
  `status` enum('pending','running','done','failed') NOT NULL DEFAULT 'pending',
  `attempts` int(11) NOT NULL DEFAULT 0,
  `max_attempts` int(11) NOT NULL DEFAULT 5,
  `due_at` datetime NOT NULL DEFAULT current_timestamp(),
  `locked_until` datetime DEFAULT NULL,
  `lock_token` char(32) DEFAULT NULL,
  `dedupe_key` varchar(191) DEFAULT NULL,
  `last_error` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_jobs_dedupe` (`dedupe_key`),
  KEY `idx_jobs_claim` (`status`,`due_at`),
  KEY `idx_jobs_lock` (`lock_token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `leads`
--

DROP TABLE IF EXISTS `leads`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `leads` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(120) NOT NULL,
  `whatsapp` varchar(20) NOT NULL,
  `email` varchar(255) DEFAULT NULL,
  `segment` varchar(60) NOT NULL,
  `source` varchar(80) NOT NULL,
  `message` varchar(1000) DEFAULT NULL,
  `consent_at` datetime NOT NULL DEFAULT current_timestamp(),
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_leads_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `marketing_links`
--

DROP TABLE IF EXISTS `marketing_links`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `marketing_links` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `utm_source` varchar(40) NOT NULL,
  `utm_medium` varchar(40) NOT NULL,
  `utm_campaign` varchar(80) NOT NULL,
  `utm_content` varchar(80) NOT NULL DEFAULT '',
  `label` varchar(120) DEFAULT NULL,
  `created_by_user_id` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_marketing_links` (`company_id`,`utm_source`,`utm_medium`,`utm_campaign`,`utm_content`),
  CONSTRAINT `fk_marketing_links_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `oauth_states`
--

DROP TABLE IF EXISTS `oauth_states`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `oauth_states` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `nonce` char(43) NOT NULL,
  `provider` varchar(30) NOT NULL,
  `company_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `redirect_uri` varchar(500) NOT NULL,
  `code_verifier_enc` text DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_oauth_states_nonce` (`nonce`),
  KEY `idx_oauth_states_expires` (`expires_at`),
  KEY `idx_oauth_states_company` (`company_id`),
  CONSTRAINT `fk_oauth_states_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `password_requests`
--

DROP TABLE IF EXISTS `password_requests`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `password_requests` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `token` varchar(100) DEFAULT NULL,
  `request_date` datetime NOT NULL DEFAULT current_timestamp(),
  `confirm_date` datetime DEFAULT NULL,
  `token_hash` char(64) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_password_requests_token_hash` (`token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `payments`
--

DROP TABLE IF EXISTS `payments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `payments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `sale_id` int(11) NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `customer_id` int(11) NOT NULL,
  `payment_type` enum('pix','pix_asaas','cartao_debito','cartao_credito','dinheiro') NOT NULL,
  `external_id` varchar(255) DEFAULT NULL,
  `create_date` datetime NOT NULL DEFAULT current_timestamp(),
  `refunded_at` datetime DEFAULT NULL,
  `external_status` varchar(40) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payments_external_id` (`external_id`),
  KEY `IDX_payments_company_id` (`company_id`),
  KEY `IDX_payments_sale_id` (`sale_id`),
  KEY `IDX_payments_customer_id` (`customer_id`),
  KEY `IDX_payments_create_date` (`create_date`),
  KEY `IDX_payments_payment_type` (`payment_type`),
  CONSTRAINT `FK_payments_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_payments_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_payments_sale_id` FOREIGN KEY (`sale_id`) REFERENCES `sales` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `plans`
--

DROP TABLE IF EXISTS `plans`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `plans` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(30) NOT NULL,
  `name` varchar(60) NOT NULL,
  `price_cents` int(11) NOT NULL DEFAULT 0,
  `commission_bps` int(11) NOT NULL,
  `billing_cycle` varchar(20) NOT NULL DEFAULT 'MONTHLY',
  `features` longtext NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_plans_code` (`code`),
  CONSTRAINT `chk_plans_features` CHECK (json_valid(`features`)),
  CONSTRAINT `chk_plans_money` CHECK (`price_cents` >= 0 and `commission_bps` between 0 and 10000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `preferences`
--

DROP TABLE IF EXISTS `preferences`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `preferences` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `products`
--

DROP TABLE IF EXISTS `products`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `products` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `value` decimal(12,2) NOT NULL,
  `description` varchar(500) DEFAULT NULL,
  `cost` decimal(12,2) NOT NULL,
  `company_id` int(11) NOT NULL,
  `unit_of_measure` int(11) NOT NULL,
  `current_stock` float NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `FK_products_company_id` (`company_id`),
  KEY `FK_products_unit_of_measure` (`unit_of_measure`),
  CONSTRAINT `FK_products_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_products_unit_of_measure` FOREIGN KEY (`unit_of_measure`) REFERENCES `units_of_measurement` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `professional_photos`
--

DROP TABLE IF EXISTS `professional_photos`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `professional_photos` (
  `professional_id` int(11) NOT NULL,
  `company_id` int(11) NOT NULL,
  `mime` varchar(20) NOT NULL,
  `bytes` mediumblob NOT NULL,
  `sha256` char(64) NOT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`professional_id`),
  KEY `idx_professional_photos_company` (`company_id`),
  CONSTRAINT `fk_professional_photos_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_professional_photos_professional` FOREIGN KEY (`professional_id`) REFERENCES `professionals` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `professional_services`
--

DROP TABLE IF EXISTS `professional_services`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `professional_services` (
  `professional_id` int(11) NOT NULL,
  `service_id` int(11) NOT NULL,
  `company_id` int(11) NOT NULL,
  PRIMARY KEY (`professional_id`,`service_id`),
  KEY `idx_professional_services_company` (`company_id`),
  KEY `idx_professional_services_service` (`service_id`),
  CONSTRAINT `fk_professional_services_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_professional_services_professional` FOREIGN KEY (`professional_id`) REFERENCES `professionals` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_professional_services_service` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `professionals`
--

DROP TABLE IF EXISTS `professionals`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `professionals` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `user_id` int(11) DEFAULT NULL,
  `name` varchar(120) NOT NULL,
  `email` varchar(255) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `photo_url` varchar(500) DEFAULT NULL,
  `color` varchar(7) DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_professionals_company` (`company_id`,`active`),
  KEY `fk_professionals_user` (`user_id`),
  CONSTRAINT `fk_professionals_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_professionals_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `public_bookings`
--

DROP TABLE IF EXISTS `public_bookings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `public_bookings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `public_id` varchar(32) NOT NULL,
  `company_id` int(11) NOT NULL,
  `appointment_id` int(11) NOT NULL,
  `customer_id` int(11) NOT NULL,
  `sale_id` int(11) DEFAULT NULL,
  `idempotency_key` varchar(64) NOT NULL,
  `request_hash` char(64) NOT NULL,
  `source` varchar(20) NOT NULL,
  `deposit_cents` int(11) NOT NULL DEFAULT 0,
  `token_expires_at` datetime NOT NULL,
  `canceled_at` datetime DEFAULT NULL,
  `cancel_reason` varchar(30) DEFAULT NULL,
  `conflict_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_public_bookings_public_id` (`public_id`),
  UNIQUE KEY `uq_public_bookings_appointment` (`appointment_id`),
  UNIQUE KEY `uq_public_bookings_idempotency` (`company_id`,`idempotency_key`),
  KEY `idx_public_bookings_sale` (`sale_id`),
  KEY `fk_public_bookings_customer` (`customer_id`),
  CONSTRAINT `fk_public_bookings_appointment` FOREIGN KEY (`appointment_id`) REFERENCES `appointments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_public_bookings_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_public_bookings_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `public_page_visits`
--

DROP TABLE IF EXISTS `public_page_visits`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `public_page_visits` (
  `company_id` int(11) NOT NULL,
  `visit_date` date NOT NULL,
  `utm_source` varchar(40) NOT NULL DEFAULT '',
  `utm_medium` varchar(40) NOT NULL DEFAULT '',
  `utm_campaign` varchar(80) NOT NULL DEFAULT '',
  `utm_content` varchar(80) NOT NULL DEFAULT '',
  `visits` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`company_id`,`visit_date`,`utm_source`,`utm_medium`,`utm_campaign`,`utm_content`),
  CONSTRAINT `fk_public_page_visits_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `rate_limits`
--

DROP TABLE IF EXISTS `rate_limits`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `rate_limits` (
  `bucket` varchar(191) NOT NULL,
  `hits` int(11) NOT NULL DEFAULT 0,
  `expires_at` datetime NOT NULL,
  PRIMARY KEY (`bucket`),
  KEY `idx_rate_limits_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `refresh_tokens`
--

DROP TABLE IF EXISTS `refresh_tokens`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `refresh_tokens` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `family_id` char(32) NOT NULL,
  `token_hash` char(64) NOT NULL,
  `expires_at` datetime NOT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `replaced_by` bigint(20) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_refresh_tokens_hash` (`token_hash`),
  KEY `idx_refresh_tokens_user` (`user_id`),
  KEY `idx_refresh_tokens_family` (`family_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sale_commissions`
--

DROP TABLE IF EXISTS `sale_commissions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sale_commissions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `sale_id` int(11) NOT NULL,
  `provider_payment_id` varchar(100) NOT NULL,
  `plan_code` varchar(30) NOT NULL,
  `commission_bps` int(11) NOT NULL,
  `gross_cents` int(11) NOT NULL,
  `commission_cents` int(11) NOT NULL,
  `split_applied` tinyint(1) NOT NULL DEFAULT 0,
  `status` enum('pending','settled','canceled','refunded') NOT NULL DEFAULT 'pending',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `settled_at` datetime DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sale_commissions_payment` (`provider_payment_id`),
  KEY `idx_sale_commissions_company` (`company_id`,`status`,`created_at`),
  KEY `idx_sale_commissions_sale` (`sale_id`),
  CONSTRAINT `fk_sale_commissions_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sale_commissions_sale` FOREIGN KEY (`sale_id`) REFERENCES `sales` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sales`
--

DROP TABLE IF EXISTS `sales`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `customer_id` int(11) NOT NULL,
  `appointment_id` int(11) DEFAULT NULL,
  `create_date` date NOT NULL DEFAULT current_timestamp(),
  `status` enum('realizada','em_aberto','cancelada') NOT NULL DEFAULT 'em_aberto',
  `pix_asaas_id` varchar(255) DEFAULT NULL,
  `pix_payload` text DEFAULT NULL,
  `pix_encoded_image` mediumtext DEFAULT NULL,
  `pix_expiration_date` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_sales_company_id` (`company_id`),
  KEY `FK_sales_appointment_id` (`appointment_id`),
  KEY `FK_sales_customer_id` (`customer_id`),
  CONSTRAINT `FK_sales_appointment_id` FOREIGN KEY (`appointment_id`) REFERENCES `appointments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_sales_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_sales_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sales_products`
--

DROP TABLE IF EXISTS `sales_products`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_products` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `sale_id` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `quantity` int(11) NOT NULL,
  `unit_price` decimal(12,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (`id`),
  KEY `FK_sales_products_sale_id` (`sale_id`),
  KEY `FK_sales_products_product_id` (`product_id`),
  CONSTRAINT `FK_sales_products_product_id` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_sales_products_sale_id` FOREIGN KEY (`sale_id`) REFERENCES `sales` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `services`
--

DROP TABLE IF EXISTS `services`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `services` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `duration` int(11) NOT NULL,
  `observations` text DEFAULT NULL,
  `value` decimal(12,2) NOT NULL,
  `company_id` int(11) NOT NULL,
  `cost` decimal(12,2) NOT NULL,
  `requires_location` tinyint(1) NOT NULL DEFAULT 0,
  `accepts_quantity` tinyint(1) NOT NULL DEFAULT 0,
  `measurement_unit` varchar(50) NOT NULL DEFAULT 'unidade',
  `public_description` varchar(600) DEFAULT NULL,
  `online_booking` tinyint(1) NOT NULL DEFAULT 1,
  `deposit_cents` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `FK_services_company_id` (`company_id`),
  CONSTRAINT `FK_services_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `stock_movements`
--

DROP TABLE IF EXISTS `stock_movements`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `stock_movements` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `product_id` int(11) NOT NULL,
  `quantity` float NOT NULL,
  `type` enum('add','remove') NOT NULL,
  `movement_date` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `FK_stock_movements_product_id` (`product_id`),
  CONSTRAINT `FK_stock_movements_product_id` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `subscription_invoices`
--

DROP TABLE IF EXISTS `subscription_invoices`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `subscription_invoices` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `subscription_id` int(11) NOT NULL,
  `plan_id` int(11) NOT NULL,
  `provider_payment_id` varchar(100) NOT NULL,
  `amount_cents` int(11) NOT NULL,
  `status` enum('pending','paid','overdue','canceled','refunded') NOT NULL DEFAULT 'pending',
  `due_date` date NOT NULL,
  `period_start` datetime DEFAULT NULL,
  `period_end` datetime DEFAULT NULL,
  `paid_at` datetime DEFAULT NULL,
  `invoice_url` varchar(500) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_subscription_invoices_provider` (`provider_payment_id`),
  KEY `idx_subscription_invoices_company` (`company_id`,`status`,`period_end`),
  KEY `fk_subscription_invoices_subscription` (`subscription_id`),
  KEY `fk_subscription_invoices_plan` (`plan_id`),
  CONSTRAINT `fk_subscription_invoices_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_subscription_invoices_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`),
  CONSTRAINT `fk_subscription_invoices_subscription` FOREIGN KEY (`subscription_id`) REFERENCES `company_subscriptions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `time_blocks`
--

DROP TABLE IF EXISTS `time_blocks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `time_blocks` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `professional_id` int(11) DEFAULT NULL,
  `starts_at` datetime NOT NULL,
  `ends_at` datetime NOT NULL,
  `reason` varchar(160) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `source` varchar(20) NOT NULL DEFAULT 'manual',
  `external_ref` varchar(255) DEFAULT NULL,
  `link_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_time_blocks_external` (`company_id`,`source`,`external_ref`),
  KEY `idx_time_blocks_company` (`company_id`,`starts_at`,`ends_at`),
  KEY `idx_time_blocks_professional` (`professional_id`),
  KEY `idx_time_blocks_link` (`link_id`),
  CONSTRAINT `fk_time_blocks_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_time_blocks_professional` FOREIGN KEY (`professional_id`) REFERENCES `professionals` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_time_blocks` CHECK (`ends_at` > `starts_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `units_of_measurement`
--

DROP TABLE IF EXISTS `units_of_measurement`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `units_of_measurement` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(10) NOT NULL,
  `abbreviation` varchar(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `usage_counters`
--

DROP TABLE IF EXISTS `usage_counters`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `usage_counters` (
  `company_id` int(11) NOT NULL,
  `metric` varchar(50) NOT NULL,
  `period` char(7) NOT NULL,
  `used` int(11) NOT NULL DEFAULT 0,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`company_id`,`metric`,`period`),
  CONSTRAINT `fk_usage_counters_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(100) DEFAULT NULL,
  `url_photo` varchar(255) DEFAULT NULL,
  `tel` varchar(20) DEFAULT NULL,
  `zip_code` varchar(10) DEFAULT NULL,
  `address` varchar(255) DEFAULT NULL,
  `city` varchar(100) DEFAULT NULL,
  `state` varchar(100) DEFAULT NULL,
  `code` varchar(100) DEFAULT NULL,
  `password_changed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `versaodb`
--

DROP TABLE IF EXISTS `versaodb`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `versaodb` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `version` varchar(10) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `whatsapp_accounts`
--

DROP TABLE IF EXISTS `whatsapp_accounts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `whatsapp_accounts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) DEFAULT NULL,
  `phone_number_id` varchar(64) NOT NULL,
  `waba_id` varchar(64) DEFAULT NULL,
  `display_phone` varchar(32) DEFAULT NULL,
  `access_token_enc` text DEFAULT NULL,
  `status` enum('active','disabled') NOT NULL DEFAULT 'active',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wa_accounts_phone` (`phone_number_id`),
  KEY `idx_wa_accounts_company` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `whatsapp_contacts`
--

DROP TABLE IF EXISTS `whatsapp_contacts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `whatsapp_contacts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `wa_id` varchar(20) NOT NULL,
  `profile_name` varchar(120) DEFAULT NULL,
  `opt_in_at` datetime DEFAULT NULL,
  `opt_in_source` varchar(40) DEFAULT NULL,
  `opted_out_at` datetime DEFAULT NULL,
  `last_inbound_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wa_contacts_wa_id` (`wa_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `whatsapp_conversations`
--

DROP TABLE IF EXISTS `whatsapp_conversations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `whatsapp_conversations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `account_id` int(11) NOT NULL,
  `contact_id` int(11) NOT NULL,
  `company_id` int(11) DEFAULT NULL,
  `state` varchar(40) NOT NULL DEFAULT 'start',
  `context` longtext DEFAULT NULL,
  `mode` enum('bot','human') NOT NULL DEFAULT 'bot',
  `assigned_user_id` int(11) DEFAULT NULL,
  `last_read_message_id` bigint(20) DEFAULT NULL,
  `handoff_at` datetime DEFAULT NULL,
  `last_inbound_at` datetime DEFAULT NULL,
  `last_message_at` datetime DEFAULT NULL,
  `lease_token` varchar(40) DEFAULT NULL,
  `lease_until` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wa_conv` (`account_id`,`contact_id`),
  KEY `idx_wa_conv_company` (`company_id`,`last_message_at`),
  CONSTRAINT `chk_wa_conv_context` CHECK (`context` is null or json_valid(`context`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `whatsapp_messages`
--

DROP TABLE IF EXISTS `whatsapp_messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `whatsapp_messages` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `conversation_id` int(11) NOT NULL,
  `company_id` int(11) DEFAULT NULL,
  `direction` enum('in','out') NOT NULL,
  `author` enum('customer','bot','agent','system') NOT NULL,
  `user_id` int(11) DEFAULT NULL,
  `wamid` varchar(191) DEFAULT NULL,
  `type` varchar(20) NOT NULL DEFAULT 'text',
  `body` text DEFAULT NULL,
  `pending_replies` mediumtext DEFAULT NULL,
  `template_name` varchar(80) DEFAULT NULL,
  `status` enum('received','queued','sent','delivered','read','failed') NOT NULL,
  `error_code` varchar(40) DEFAULT NULL,
  `attempts` int(11) NOT NULL DEFAULT 0,
  `billable` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `status_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wa_messages_wamid` (`wamid`),
  KEY `idx_wa_messages_conv` (`conversation_id`,`id`),
  KEY `idx_wa_messages_company` (`company_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `whatsapp_sessions`
--

DROP TABLE IF EXISTS `whatsapp_sessions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `whatsapp_sessions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `phone` varchar(20) NOT NULL,
  `messages` longtext DEFAULT NULL,
  `collected_data` longtext DEFAULT NULL CHECK (json_valid(`collected_data`)),
  `stage` varchar(50) DEFAULT 'menu',
  `status` varchar(50) DEFAULT 'active',
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `whatsapp_settings`
--

DROP TABLE IF EXISTS `whatsapp_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `whatsapp_settings` (
  `company_id` int(11) NOT NULL,
  `bot_enabled` tinyint(1) NOT NULL DEFAULT 1,
  `ai_enabled` tinyint(1) NOT NULL DEFAULT 1,
  `welcome_text` varchar(300) DEFAULT NULL,
  `ai_daily_token_limit` int(11) DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `whatsapp_templates`
--

DROP TABLE IF EXISTS `whatsapp_templates`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `whatsapp_templates` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(80) NOT NULL,
  `language` varchar(10) NOT NULL DEFAULT 'pt_BR',
  `category` varchar(20) NOT NULL DEFAULT 'UTILITY',
  `purpose` varchar(40) NOT NULL,
  `body_preview` text NOT NULL,
  `param_count` int(11) NOT NULL DEFAULT 0,
  `status` enum('pending','approved','rejected','disabled') NOT NULL DEFAULT 'pending',
  `synced_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wa_templates` (`name`,`language`),
  KEY `idx_wa_templates_purpose` (`purpose`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping routines for database 'agendaspro_db'
--

--
-- Final view structure for view `appointment_status_view`
--

/*!50001 DROP VIEW IF EXISTS `appointment_status_view`*/;
/*!50001 SET @saved_cs_client          = @@character_set_client */;
/*!50001 SET @saved_cs_results         = @@character_set_results */;
/*!50001 SET @saved_col_connection     = @@collation_connection */;
/*!50001 SET character_set_client      = utf8mb4 */;
/*!50001 SET character_set_results     = utf8mb4 */;
/*!50001 SET collation_connection      = utf8mb4_uca1400_ai_ci */;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 SQL SECURITY INVOKER */
/*!50001 VIEW `appointment_status_view` AS select `a`.`id` AS `id`,`a`.`customer_id` AS `customer_id`,`a`.`customer_name` AS `customer_name`,`a`.`date` AS `date`,`a`.`duration` AS `duration`,`a`.`observations` AS `observations`,`a`.`company_id` AS `company_id`,`a`.`checkin` AS `checkin`,`a`.`checkout` AS `checkout`,`a`.`canceled` AS `canceled`,`a`.`zip_code` AS `zip_code`,`a`.`address` AS `address`,`a`.`number` AS `number`,`a`.`complement` AS `complement`,`a`.`city` AS `city`,`a`.`state` AS `state`,`a`.`notified_1h` AS `notified_1h`,`a`.`payment_status` AS `payment_status`,`a`.`professional_id` AS `professional_id`,`a`.`notified_2h` AS `notified_2h`,`a`.`hold_expires_at` AS `hold_expires_at`,`a`.`source` AS `source`,case when `a`.`canceled` = 1 then 'cancelado' when `a`.`payment_status` = 'pendente' and `a`.`hold_expires_at` is not null and `a`.`hold_expires_at` <= current_timestamp() then 'cancelado' when `a`.`checkout` is not null then 'realizado' when `a`.`checkin` is not null and exists(select 1 from (`config_companies_preferences` `ccp` join `preferences` `p` on(`p`.`id` = `ccp`.`preference_id`)) where `ccp`.`company_id` = `a`.`company_id` and `p`.`code` = 'auto_finish_appointments' and `ccp`.`active` = 1 limit 1) and current_timestamp() >= `a`.`checkin` + interval `a`.`duration` minute then 'realizado' when `a`.`checkin` is not null then 'iniciado' when `a`.`payment_status` = 'pendente' then 'pendente_pagamento' else 'agendado' end AS `status` from `appointments` `a` */;
/*!50001 SET character_set_client      = @saved_cs_client */;
/*!50001 SET character_set_results     = @saved_cs_results */;
/*!50001 SET collation_connection      = @saved_col_connection */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*M!100616 SET NOTE_VERBOSITY=@OLD_NOTE_VERBOSITY */;

-- Dump completed

CREATE OR REPLACE SQL SECURITY INVOKER VIEW appointment_status_view AS
SELECT a.*,
  CASE
    WHEN a.canceled = 1 THEN 'cancelado'
    -- F3: reserva com sinal pendente e prazo vencido conta como cancelada (estado derivado do tempo).
    WHEN a.payment_status = 'pendente' AND a.hold_expires_at IS NOT NULL AND a.hold_expires_at <= CURRENT_TIMESTAMP THEN 'cancelado'
    WHEN a.checkout IS NOT NULL THEN 'realizado'
    WHEN a.checkin IS NOT NULL AND EXISTS (
      SELECT 1 FROM config_companies_preferences ccp
      JOIN preferences p ON p.id = ccp.preference_id
      WHERE ccp.company_id = a.company_id
        AND p.code = 'auto_finish_appointments' AND ccp.active = 1
    ) AND CURRENT_TIMESTAMP >= a.checkin + INTERVAL a.duration MINUTE THEN 'realizado'
    WHEN a.checkin IS NOT NULL THEN 'iniciado'
    WHEN a.payment_status = 'pendente' THEN 'pendente_pagamento'
    ELSE 'agendado'
  END AS status
FROM appointments a;
