CREATE TABLE companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  address VARCHAR(255) NOT NULL
);

CREATE TABLE config_opening_hours (
  id INT AUTO_INCREMENT PRIMARY KEY,
  day VARCHAR(20) NOT NULL,
  initial_date TIME NOT NULL,
  final_date TIME NOT NULL,
  company INT NOT NULL,
  FOREIGN KEY (company) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE config_notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  active INT NOT NULL,
  company INT NOT NULL,
  FOREIGN KEY (company) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(100) NOT NULL,
  url_photo VARCHAR(255),
  tel VARCHAR(20),
  zip_code VARCHAR(10),
  address VARCHAR(255),
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100),
  company INT NOT NULL,
  role INT NOT NULL DEFAULT 2,
  temporary_password VARCHAR(20) NOT NULL,
  FOREIGN KEY (company) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE appointments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  customer_name VARCHAR(255) NOT NULL,
  service VARCHAR(255) NOT NULL,
  date DATETIME NOT NULL,
  duration INT NOT NULL, -- duração em minutos
  observations TEXT,
  FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  birthday DATE NOT NULL,
  tel VARCHAR(20),
  image VARCHAR(255)
);

CREATE TABLE services (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  duration INT NOT NULL, -- duração em minutos
  observations TEXT,
  value FLOAT NOT NULL, -- valor do serviço
  company INT NOT NULL,
  FOREIGN KEY (company) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE accounts_receivable (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  value FLOAT NOT NULL,  -- valor da dívida
  due_date DATE NOT NULL, -- data de vencimento
  status VARCHAR(10) NOT NULL DEFAULT "EM ABERTO",  -- status do pagamento
  observations TEXT,  -- observações adicionais
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE versaodb (
    id INT AUTO_INCREMENT PRIMARY KEY,
    version varchar(10) NOT NULL
);

--  25     01     28    .              01
-- (ANO)  (MÊS)  (DIA)     (VERSIONAMENTOS NO DIA)
INSERT INTO versaodb (version) VALUES ("250128.01");