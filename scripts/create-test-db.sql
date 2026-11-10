-- Runs once, the first time the container starts. Tests use their own database
-- so they can never touch dev data.
CREATE DATABASE transactflow_test;
