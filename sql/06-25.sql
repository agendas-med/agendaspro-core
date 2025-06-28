alter table users add column code varchar(100);
alter table users modify column password varchar(100);

insert into versaodb (version) values ("2025.06.01");