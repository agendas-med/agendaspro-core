-- Follow-up 1: valores em dinheiro saem de FLOAT (erro de arredondamento binário) para DECIMAL(12,2).
-- Quantidades/estoque (products.current_stock, stock_movements.quantity) continuam FLOAT: não são dinheiro
-- e podem ser fracionadas. O pool converte DECIMAL para Number (mysql.js), então a API segue numérica.
-- Idempotente: MODIFY para o mesmo tipo não altera nada numa segunda execução.
ALTER TABLE accounts_receivable MODIFY `amount` DECIMAL(12,2) NOT NULL;
ALTER TABLE payments MODIFY `amount` DECIMAL(12,2) NOT NULL;
ALTER TABLE products MODIFY `value` DECIMAL(12,2) NOT NULL, MODIFY `cost` DECIMAL(12,2) NOT NULL;
ALTER TABLE services MODIFY `value` DECIMAL(12,2) NOT NULL, MODIFY `cost` DECIMAL(12,2) NOT NULL;
