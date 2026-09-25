-- Performance is measured when asked (contract decision §51); the minute-by-minute snapshots only fed
-- audit.getReport's `performance` kind, which contract decision §73 removed. The samples are dropped with it.
DROP TABLE `performance_snapshots`;