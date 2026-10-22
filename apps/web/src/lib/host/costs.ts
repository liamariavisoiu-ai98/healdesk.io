/**
 * What the AWS host costs a month in each state, for /admin/host. Estimates,
 * in US dollars, us-east-1, on-demand, 730 hours: the same figures as
 * infra/aws/README.md ("Costs" and "Standby"), which says where each comes
 * from. Fixed-rate lines are exact; usage lines are low-traffic guesses. Keep
 * the two in step.
 */

export type CostLine = { item: string; dollars: number; note?: string };

/** The lean profile production.tfvars builds (13 October 2026). */
export const ACTIVE_COSTS: readonly CostLine[] = [
  { item: "Load balancer: hours, a little LCU, two public IPv4 addresses", dollars: 25.19 },
  { item: "One web task (ARM64, 0.25 vCPU, 1 GB): app, TLS sidecar, worker", dollars: 8.51 },
  { item: "One voice task (ARM64, 0.25 vCPU, 1 GB) and its alarm: enable_voice, set on 22 October 2026 and live once applied", dollars: 8.61 },
  { item: "RDS db.t4g.micro, single-AZ, 20 GiB gp3", dollars: 13.98 },
  { item: "NAT instance t4g.nano, its public address and disk", dollars: 7.36 },
  { item: "KMS: the product key and the state key", dollars: 2.2 },
  { item: "CloudTrail storage, CloudWatch Logs, nine alarms", dollars: 2.9 },
  { item: "Secrets Manager: the database's master secret", dollars: 0.4 },
  { item: "ECR images", dollars: 1.5, note: "1 to 2" },
  { item: "AWS Config", dollars: 3.0 },
  { item: "GuardDuty, foundational", dollars: 4.0 },
  { item: "SES: the transcript emails", dollars: 0.1, note: "under 0.10" },
];

/**
 * What is left in standby (infra/aws variables.tf, `standby`), line by line.
 * Everything that bills by the hour is gone: the load balancer and its two
 * addresses, the task, the database instance, the NAT instance and its
 * address, the master secret (deleted with the instance) and every alarm.
 */
export const STANDBY_COSTS: readonly CostLine[] = [
  { item: "KMS: the product key and the state key", dollars: 2.0, note: "+$1 each a month after a key's first yearly rotation" },
  { item: "ECR images, kept for the way back", dollars: 0.5, note: "under 0.20 after a few deploys, up to 2 with 30 images per repository" },
  { item: "The database's standby snapshot (synthetic data, about 1 to 2 GB at $0.095/GB)", dollars: 0.15 },
  { item: "Its automated backups, kept 35 days after the deletion, then gone", dollars: 0.2, note: "first 35 days only" },
  { item: "AWS Config: configuration items, rare with nothing running", dollars: 0.5 },
  { item: "GuardDuty: management events only, no traffic to read", dollars: 0.25 },
  { item: "CloudTrail and Config buckets, the state bucket, log storage", dollars: 0.3 },
  { item: "Alarms (none left), public IPv4 (none), Parameter Store, SES identity, VPC, ACM, SNS", dollars: 0 },
];

export function total(lines: readonly CostLine[]): number {
  return Math.round(lines.reduce((sum, line) => sum + line.dollars, 0) * 100) / 100;
}

/** "$69.14", for a table cell. */
export function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}
