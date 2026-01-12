-- check sizes of progress objects
SELECT 
    course_id, 
    pg_size_pretty(octet_length(progress::text)) as size_raw,
    octet_length(progress::text) as size_bytes
FROM user_course_progress
ORDER BY size_bytes DESC
LIMIT 20;

-- check total table size details
SELECT
    n.nspname AS schema_name,
    c.relname AS table_name,
    pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
    pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
    pg_size_pretty(pg_indexes_size(c.oid)) AS index_size,
    reltuples::bigint AS row_count
FROM pg_class c
LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'user_course_progress';
