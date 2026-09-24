-- The model's turns of a run as the hub saw them (contract decision §41, the trajectory): written
-- when the run ends. Older runs keep NULL, and their trajectory shows no times for their turns.
ALTER TABLE `runs` ADD `timing` text;
