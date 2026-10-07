# The product database, under the AWS BAA. Chosen over Neon because the
# launch plan keeps backups for 35 days and Neon's Scale plan restores from at
# most 30.
#
# The master user is RDS's own, with its password in a Secrets Manager secret
# RDS manages, so it never passes through Terraform. It is used once, by the
# db-admin task, to run apps/app/scripts/provision-roles.sql; the app connects
# as healdesk_app and migrations run as healdesk_migrator.

resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "${var.name}-pg${var.db_engine_version}"
  family = "postgres${var.db_engine_version}"

  # The BAA makes encryption in transit an obligation (§4.3.1). The app also
  # refuses a certificate it cannot verify in production (src/db/index.ts).
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "main" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  db_name                       = "healdesk"
  username                      = "healdesk_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.main.key_id

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.main.arn

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.main.name

  backup_retention_period  = var.db_backup_retention_days
  backup_window            = "07:00-07:30"
  maintenance_window       = "sun:08:00-sun:08:30"
  copy_tags_to_snapshot    = true
  delete_automated_backups = false

  auto_minor_version_upgrade = true
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name}-final"

  # Query text can carry patient data; nothing exports it out of RDS.
  performance_insights_enabled = false

  lifecycle {
    prevent_destroy = true
  }
}
