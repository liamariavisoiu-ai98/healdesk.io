-- Changes nothing: a statement that matches no row, to prove the path end to end
-- (the role connects, the clinic is set, the statement runs, the count is 0).
-- Dry-run it, then apply it with expect_rows 0.
update clinic_closures set label = label where false;
