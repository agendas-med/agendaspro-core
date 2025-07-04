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