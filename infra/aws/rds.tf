# RDS for PostgreSQL 17, private, encrypted with our key from the moment it is
# created (encryption at rest cannot be added later, and the key of an
# encrypted instance cannot be changed).
#
# The app never connects as the master user. The master password is managed by
# RDS in Secrets Manager, rotated every seven days, and read only by the
# one-off db-bootstrap task that creates healdesk_migrator and healdesk_app.

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "RDS PostgreSQL: 5432 from the ECS tasks only, no egress"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-rds"
  }
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_tasks" {
  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from the web, worker, migrate and db-bootstrap tasks"
  ip_protocol                  = "tcp"
  from_port                    = local.db_port
  to_port                      = local.db_port
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_db_subnet_group" "main" {
  name        = local.name
  description = "Private subnets for ${local.name}"
  subnet_ids  = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name        = "${local.name}-postgres${split(".", var.postgres_version)[0]}"
  family      = "postgres${split(".", var.postgres_version)[0]}"
  description = "${local.name}: TLS forced, SCRAM passwords, no statement text or row values in the engine log"

  # Refuse any connection without TLS (the default on 15+, set explicitly so
  # it cannot drift), and nothing older than TLS 1.2.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "ssl_min_protocol_version"
    value        = "TLSv1.2"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "password_encryption"
    value        = "scram-sha-256"
    apply_method = "pending-reboot"
  }

  # The engine log is exported to CloudWatch, where it never expires and is
  # the only place a failed migration explains itself (drizzle-kit exits 1
  # with no text). It must not carry PHI or passwords, and three settings keep
  # them out:
  #
  #   - log_error_verbosity terse drops the DETAIL, HINT, QUERY and CONTEXT
  #     lines, which print key values and failing rows;
  #   - log_statement none logs no statement as it runs;
  #   - log_min_error_statement panic keeps the text of a failing statement
  #     out. At PostgreSQL's default (error) every failing statement is logged
  #     in full after its ERROR line, whatever the other two say: a failed
  #     ALTER ROLE ... PASSWORD '...' from the db-bootstrap task (psql fills
  #     the password in on the client), or an INSERT carrying patient values.
  #     The ERROR line itself stays, which is what a failed migration needs.
  #
  # What remains: a primary message that quotes its own input (invalid input
  # syntax for type uuid: "...") is still logged at ERROR. The app's queries
  # are parameterised, so a bind value appears only there.
  parameter {
    name         = "log_error_verbosity"
    value        = "terse"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "log_statement"
    value        = "none"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "log_min_error_statement"
    value        = "panic"
    apply_method = "immediate"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.db_instance_class

  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true
  kms_key_id        = aws_kms_key.main.arn

  db_name                       = local.db_name
  port                          = local.db_port
  username                      = local.db_username
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.main.arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az
  network_type           = "IPV4"

  parameter_group_name       = aws_db_parameter_group.main.name
  ca_cert_identifier         = "rds-ca-rsa2048-g1"
  auto_minor_version_upgrade = true
  backup_window              = var.db_backup_window
  maintenance_window         = var.db_maintenance_window

  # Exactly 35 days of point-in-time recovery, and nothing kept longer: the
  # clinic agreement (1.3.0, release gate 18) promises that no copy of deleted
  # data outlives 35 days. So no final snapshot on deletion; the automated
  # backups are kept after a deletion and expire on their own 35-day clock.
  backup_retention_period  = 35
  skip_final_snapshot      = true
  delete_automated_backups = false
  copy_tags_to_snapshot    = true
  deletion_protection      = true

  enabled_cloudwatch_logs_exports = ["postgresql"]

  # Database Insights in the free standard mode (the API defaults to the paid
  # advanced mode), with Performance Insights data under our key for 7 days.
  # The key, like the storage key, is fixed once chosen.
  database_insights_mode                = "standard"
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.main.arn
  performance_insights_retention_period = 7

  # Enhanced Monitoring is off: it writes to the account-wide RDSOSMetrics log
  # group, which AWS creates without our key. The standard CloudWatch metrics
  # and Database Insights cover the pilot.
  monitoring_interval = 0

  # IAM database authentication is off: the app holds long-lived pools on a
  # static URL, IAM tokens last 15 minutes, and the feature costs 300-1000 MiB
  # of a small instance's memory.
  iam_database_authentication_enabled = false

  depends_on = [aws_cloudwatch_log_group.rds_postgresql]

  lifecycle {
    prevent_destroy = true
  }

  #checkov:skip=CKV_AWS_157:Multi-AZ is a variable (db_multi_az), off in the lean pilot by the owner's decision; a database outage degrades to the clinic's direct line.
  #checkov:skip=CKV_AWS_118:Enhanced Monitoring writes to RDSOSMetrics, an account-wide log group AWS creates without our KMS key; standard metrics and Database Insights are used instead.
  #checkov:skip=CKV_AWS_161:IAM database authentication does not fit long-lived pg pools on a static URL (15-minute tokens) and costs 300-1000 MiB of instance memory; passwords are SCRAM over verified TLS.
}
