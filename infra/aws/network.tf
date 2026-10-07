# Two availability zones, because an RDS subnet group needs two. The load
# balancer and the NAT gateway sit in the public subnets; every task and the
# database sit in the private ones and reach the internet (Anthropic, Stripe,
# Resend, Meta, Google) only through the one NAT gateway.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs             = slice(data.aws_availability_zones.available.names, 0, 2)
  public_subnets  = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnets = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i + 10)]
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = local.public_subnets[count.index]

  tags = { Name = "${var.name}-public-${local.azs[count.index]}" }
}

resource "aws_subnet" "private" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = local.private_subnets[count.index]

  tags = { Name = "${var.name}-private-${local.azs[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  count = length(local.azs)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One NAT gateway, not one per zone: a zone outage stops outbound calls until
# it recovers, which costs less than a second gateway at this size.
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = var.name }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-private" }
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main.id
}

resource "aws_route_table_association" "private" {
  count = length(local.azs)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# Free, and keeps transcript objects and ECR's image layers off the NAT
# gateway and the internet.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${var.name}-s3" }
}

# --- Security groups ---------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "The load balancer: HTTPS and the HTTP redirect from anywhere"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "web" {
  name        = "${var.name}-web"
  description = "The web tier: port 3001 from the load balancer only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "worker" {
  name        = "${var.name}-worker"
  description = "The worker: nothing inbound"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "admin" {
  name        = "${var.name}-admin"
  description = "One-off tasks (roles, migrations, queue install): nothing inbound"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Postgres: 5432 from the app's own tasks only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001
}

resource "aws_vpc_security_group_egress_rule" "tasks_out" {
  for_each = {
    web    = aws_security_group.web.id
    worker = aws_security_group.worker.id
    admin  = aws_security_group.admin.id
  }

  security_group_id = each.value
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_tasks" {
  for_each = {
    web    = aws_security_group.web.id
    worker = aws_security_group.worker.id
    admin  = aws_security_group.admin.id
  }

  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
