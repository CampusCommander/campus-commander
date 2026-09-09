\set ON_ERROR_STOP on
-- Run each section on its database server as the district provisioning operator.
-- Supply quoted psql variables through a protected operator script or interactive session.
-- Never send operator credentials to application containers.
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_role', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_role') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'migration_role', :'migration_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'migration_role') \gexec
SELECT format('CREATE DATABASE %I OWNER %I ENCODING %L TEMPLATE template0', :'app_database', :'migration_role', 'UTF8')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'app_database') \gexec
REVOKE ALL ON DATABASE :"app_database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"app_database" TO :"app_role";

-- Run this section on the Kestra database server.
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'kestra_role', :'kestra_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'kestra_role') \gexec
SELECT format('CREATE DATABASE %I OWNER %I ENCODING %L TEMPLATE template0', :'kestra_database', :'kestra_role', 'UTF8')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'kestra_database') \gexec
REVOKE ALL ON DATABASE :"kestra_database" FROM PUBLIC;
