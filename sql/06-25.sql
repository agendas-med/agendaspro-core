alter table users add column code varchar(100);
alter table users modify column password varchar(100);

insert into versaodb (version) values ("2025.06.01");

create table products (
	id int not null primary key auto_increment,
    name varchar(100) not null,
    value float not null,
    description varchar(500),
    cost float not null,
    company_id int not null,
    constraint FK_products_company_id foreign key (company_id) references companies(id) on delete cascade
);

insert into versaodb (version) values ("2025.06.02");

create table sales (
	id int not null primary key auto_increment,
    company_id int not null,
    customer_id int not null,
    appointment_id int,
    create_date date not null default NOW(),
    status enum("realizada", "em_aberto", "cancelada") not null default "em_aberto",
    constraint FK_sales_company_id foreign key (company_id) references companies(id) on delete cascade,
    constraint FK_sales_appointment_id foreign key (appointment_id) references appointments(id) on delete cascade,
	constraint FK_sales_customer_id foreign key (customer_id) references customers(id) on delete cascade
);

create table sales_products (
	id int not null primary key auto_increment,
    sale_id int not null,
    product_id int not null,
    constraint FK_sales_products_sale_id foreign key (sale_id) references sales(id) on delete cascade,
    constraint FK_sales_products_product_id foreign key (product_id) references products(id) on delete cascade
);

insert into versaodb (version) values ("2025.06.03");

create table units_of_measurement (
	id int not null primary key auto_increment,
    name varchar(10) not null,
    abbreviation varchar(3) not null
);

alter table products add column unit_of_measure int not null;
alter table products add constraint FK_products_unit_of_measure FOREIGN KEY (unit_of_measure) REFERENCES units_of_measurement(id) ON DELETE CASCADE;

INSERT INTO units_of_measurement (name, abbreviation) VALUES
('Unidade', 'un'),       -- Para itens contados individualmente (e.g., uma caneta, um serviço)
('Quilograma', 'kg'),    -- Para peso (e.g., café, açúcar)
('Litro', 'L'),          -- Para volume (e.g., água, leite)
('Metro', 'm'),          -- Para comprimento (e.g., tecido, fio)
('Par', 'par'),          -- Para itens vendidos em pares (e.g., meias, sapatos)
('Caixa', 'cx'),         -- Para caixas de produtos (e.g., uma caixa de lápis)
('Pacote', 'pct'),       -- Para pacotes de produtos (e.g., um pacote de pilhas)
('Conjunto', 'cj'); 

insert into versaodb (version) values ("2025.06.04");

alter table sales_products add column quantity int not null;

insert into versaodb (version) values ("2025.07.01");

alter table products add column current_stock float not null default 0;

create table stock_movements (
	id int not null primary key auto_increment,
    product_id int not null,
    quantity float not null,
    type enum("add", "remove") not null,
    movement_date datetime not null default now(),
    constraint FK_stock_movements_product_id foreign key (product_id) references products(id) on delete cascade
);

insert into versaodb (version) values ("2025.09.01");