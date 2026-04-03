CREATE DATABASE  IF NOT EXISTS `agendaspro_db` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci */;
USE `agendaspro_db`;
-- MySQL dump 10.13  Distrib 8.0.45, for Win64 (x86_64)
--
-- Host: localhost    Database: agendaspro_db
-- ------------------------------------------------------
-- Server version	12.2.2-MariaDB-ubu2404

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `accounts_receivable`
--

DROP TABLE IF EXISTS `accounts_receivable`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `accounts_receivable` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `customer_id` int(11) NOT NULL,
  `value` float NOT NULL,
  `due_date` date NOT NULL,
  `status` varchar(10) NOT NULL DEFAULT 'EM ABERTO',
  `observations` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `customer_id` (`customer_id`),
  CONSTRAINT `accounts_receivable_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `appointment_services`
--

DROP TABLE IF EXISTS `appointment_services`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `appointment_services` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `service_id` int(11) NOT NULL,
  `appointment_id` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_appointment_services_service_id` (`service_id`),
  KEY `FK_appointment_services_appointment_id` (`appointment_id`),
  CONSTRAINT `FK_appointment_services_appointment_id` FOREIGN KEY (`appointment_id`) REFERENCES `appointments` (`id`),
  CONSTRAINT `FK_appointment_services_service_id` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=105 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Temporary view structure for view `appointment_status_view`
--

DROP TABLE IF EXISTS `appointment_status_view`;
/*!50001 DROP VIEW IF EXISTS `appointment_status_view`*/;
SET @saved_cs_client     = @@character_set_client;
/*!50503 SET character_set_client = utf8mb4 */;
/*!50001 CREATE VIEW `appointment_status_view` AS SELECT 
 1 AS `id`,
 1 AS `customer_id`,
 1 AS `customer_name`,
 1 AS `date`,
 1 AS `duration`,
 1 AS `observations`,
 1 AS `company_id`,
 1 AS `checkin`,
 1 AS `checkout`,
 1 AS `canceled`,
 1 AS `status`*/;
SET character_set_client = @saved_cs_client;

--
-- Table structure for table `appointments`
--

DROP TABLE IF EXISTS `appointments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
  PRIMARY KEY (`id`),
  KEY `FK_appointments_customer_id` (`customer_id`),
  KEY `FK_appointments_company_id` (`company_id`),
  CONSTRAINT `FK_appointments_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `FK_appointments_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=18 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `business_types`
--

DROP TABLE IF EXISTS `business_types`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `business_types` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=55 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `companies`
--

DROP TABLE IF EXISTS `companies`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `companies` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `address` varchar(255) NOT NULL,
  `city` varchar(100) DEFAULT NULL,
  `state` varchar(2) DEFAULT NULL,
  `business_type` int(11) DEFAULT NULL,
  `zip_code` varchar(9) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_companies_business_type` (`business_type`),
  CONSTRAINT `FK_companies_business_type` FOREIGN KEY (`business_type`) REFERENCES `business_types` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=20 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `company_invitations`
--

DROP TABLE IF EXISTS `company_invitations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `company_invitations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `invited_by` int(11) NOT NULL,
  `invitation_date` datetime DEFAULT current_timestamp(),
  `status` enum('pending','accepted','declined') DEFAULT 'pending',
  `invited_user` varchar(255) NOT NULL,
  `token` varchar(50) NOT NULL,
  `role_id` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_invitations_company` (`company_id`),
  KEY `FK_company_invitatios_role_id` (`role_id`),
  KEY `FK_company_invitations_user_email` (`invited_user`),
  CONSTRAINT `FK_company_invitatios_role_id` FOREIGN KEY (`role_id`) REFERENCES `config_company_roles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_invitations_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=39 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `company_members`
--

DROP TABLE IF EXISTS `company_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=28 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_companies_preferences`
--

DROP TABLE IF EXISTS `config_companies_preferences`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=43 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_companies_schedule`
--

DROP TABLE IF EXISTS `config_companies_schedule`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `config_companies_schedule` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `day` int(11) NOT NULL,
  `initial_date` varchar(5) NOT NULL,
  `final_date` varchar(5) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_config_companies_schedule_company_id` (`company_id`),
  CONSTRAINT `FK_config_companies_schedule_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=44 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_company_roles`
--

DROP TABLE IF EXISTS `config_company_roles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=31 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_notifications`
--

DROP TABLE IF EXISTS `config_notifications`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `config_notifications` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `active` int(11) NOT NULL,
  `company` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `company` (`company`),
  CONSTRAINT `config_notifications_ibfk_1` FOREIGN KEY (`company`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_opening_hours`
--

DROP TABLE IF EXISTS `config_opening_hours`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `config_opening_hours` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `day` varchar(20) NOT NULL,
  `initial_date` time NOT NULL,
  `final_date` time NOT NULL,
  `company` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `company` (`company`),
  CONSTRAINT `config_opening_hours_ibfk_1` FOREIGN KEY (`company`) REFERENCES `companies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `config_users_roles`
--

DROP TABLE IF EXISTS `config_users_roles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=31 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `customers`
--

DROP TABLE IF EXISTS `customers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `birthday` datetime NOT NULL,
  `tel` varchar(20) DEFAULT NULL,
  `image` varchar(255) DEFAULT NULL,
  `company_id` int(11) NOT NULL,
  `cpf` varchar(14) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_customers_company_id` (`company_id`),
  KEY `IDX_name` (`name`),
  CONSTRAINT `FK_customers_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `password_requests`
--

DROP TABLE IF EXISTS `password_requests`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `password_requests` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `token` varchar(100) NOT NULL,
  `request_date` datetime NOT NULL DEFAULT current_timestamp(),
  `confirm_date` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `payments`
--

DROP TABLE IF EXISTS `payments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `payments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `sale_id` int(11) NOT NULL,
  `amount` float NOT NULL,
  `customer_id` int(11) NOT NULL,
  `payment_type` enum('pix','cartao_debito','cartao_credito','dinheiro') NOT NULL,
  `create_date` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `IDX_payments_company_id` (`company_id`),
  KEY `IDX_payments_sale_id` (`sale_id`),
  KEY `IDX_payments_customer_id` (`customer_id`),
  KEY `IDX_payments_create_date` (`create_date`),
  KEY `IDX_payments_payment_type` (`payment_type`),
  CONSTRAINT `FK_payments_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_payments_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_payments_sale_id` FOREIGN KEY (`sale_id`) REFERENCES `sales` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `preferences`
--

DROP TABLE IF EXISTS `preferences`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `preferences` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB AUTO_INCREMENT=16 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `products`
--

DROP TABLE IF EXISTS `products`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `products` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `value` float NOT NULL,
  `description` varchar(500) DEFAULT NULL,
  `cost` float NOT NULL,
  `company_id` int(11) NOT NULL,
  `unit_of_measure` int(11) NOT NULL,
  `current_stock` float NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `FK_products_company_id` (`company_id`),
  KEY `FK_products_unit_of_measure` (`unit_of_measure`),
  CONSTRAINT `FK_products_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_products_unit_of_measure` FOREIGN KEY (`unit_of_measure`) REFERENCES `units_of_measurement` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sales`
--

DROP TABLE IF EXISTS `sales`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `company_id` int(11) NOT NULL,
  `customer_id` int(11) NOT NULL,
  `appointment_id` int(11) DEFAULT NULL,
  `create_date` date NOT NULL DEFAULT current_timestamp(),
  `status` enum('realizada','em_aberto','cancelada') NOT NULL DEFAULT 'em_aberto',
  PRIMARY KEY (`id`),
  KEY `FK_sales_company_id` (`company_id`),
  KEY `FK_sales_appointment_id` (`appointment_id`),
  KEY `FK_sales_customer_id` (`customer_id`),
  CONSTRAINT `FK_sales_appointment_id` FOREIGN KEY (`appointment_id`) REFERENCES `appointments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_sales_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_sales_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sales_products`
--

DROP TABLE IF EXISTS `sales_products`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_products` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `sale_id` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `quantity` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_sales_products_sale_id` (`sale_id`),
  KEY `FK_sales_products_product_id` (`product_id`),
  CONSTRAINT `FK_sales_products_product_id` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_sales_products_sale_id` FOREIGN KEY (`sale_id`) REFERENCES `sales` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `services`
--

DROP TABLE IF EXISTS `services`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `services` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `duration` int(11) NOT NULL,
  `observations` text DEFAULT NULL,
  `value` float NOT NULL,
  `company_id` int(11) NOT NULL,
  `cost` float NOT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_services_company_id` (`company_id`),
  CONSTRAINT `FK_services_company_id` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=12 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `stock_movements`
--

DROP TABLE IF EXISTS `stock_movements`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `stock_movements` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `product_id` int(11) NOT NULL,
  `quantity` float NOT NULL,
  `type` enum('add','remove') NOT NULL,
  `movement_date` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `FK_stock_movements_product_id` (`product_id`),
  CONSTRAINT `FK_stock_movements_product_id` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `units_of_measurement`
--

DROP TABLE IF EXISTS `units_of_measurement`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `units_of_measurement` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(10) NOT NULL,
  `abbreviation` varchar(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB AUTO_INCREMENT=31 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `versaodb`
--

DROP TABLE IF EXISTS `versaodb`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `versaodb` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `version` varchar(10) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `whatsapp_sessions`
--

DROP TABLE IF EXISTS `whatsapp_sessions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `whatsapp_sessions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `phone` varchar(20) NOT NULL,
  `messages` longtext DEFAULT NULL,
  `collected_data` longtext DEFAULT NULL CHECK (json_valid(`collected_data`)),
  `stage` varchar(50) DEFAULT 'menu',
  `status` enum('active','closed') NOT NULL DEFAULT 'active',
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=34 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping events for database 'agendaspro_db'
--

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
/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */
/*!50001 VIEW `appointment_status_view` AS select `a`.`id` AS `id`,`a`.`customer_id` AS `customer_id`,`a`.`customer_name` AS `customer_name`,`a`.`date` AS `date`,`a`.`duration` AS `duration`,`a`.`observations` AS `observations`,`a`.`company_id` AS `company_id`,`a`.`checkin` AS `checkin`,`a`.`checkout` AS `checkout`,`a`.`canceled` AS `canceled`,case when `a`.`canceled` = 1 then 'cancelado' when `a`.`checkin` is not null and `a`.`checkout` is not null then 'realizado' when `a`.`checkin` is not null and exists(select 1 from (`config_companies_preferences` `ccp` join `preferences` `p` on(`p`.`id` = `ccp`.`preference_id`)) where `ccp`.`company_id` = `a`.`company_id` and `p`.`code` = 'auto_finish_appointments' limit 1) and current_timestamp() >= `a`.`checkin` + interval `a`.`duration` minute then 'realizado' when `a`.`checkin` is not null then 'iniciado' else 'agendado' end AS `status` from `appointments` `a` */;
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
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-04-02 21:11:32
