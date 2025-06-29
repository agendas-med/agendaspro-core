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
