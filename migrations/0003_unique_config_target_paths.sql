-- Reconcile legacy configs that bind the same target file, then enforce one
-- owning config per non-null target_path. The survivor is the record with the
-- richest snapshot history (with deterministic tie-breakers).

LOCK TABLE configs, config_snapshots, profile_configs IN SHARE ROW EXCLUSIVE MODE;

WITH ranked AS (
    SELECT
        c.id,
        FIRST_VALUE(c.id) OVER (
            PARTITION BY c.target_path
            ORDER BY
                (SELECT COUNT(*) FROM config_snapshots s WHERE s.config_id = c.id) DESC,
                c.version DESC,
                c.updated_at DESC,
                c.created_at ASC,
                c.id ASC
        ) AS survivor_id
    FROM configs c
    WHERE c.target_path IS NOT NULL
)
INSERT INTO profile_configs (profile_id, config_id, sort_order)
SELECT pc.profile_id, ranked.survivor_id, MIN(pc.sort_order)
FROM profile_configs pc
JOIN ranked ON ranked.id = pc.config_id
WHERE ranked.id <> ranked.survivor_id
GROUP BY pc.profile_id, ranked.survivor_id
ON CONFLICT (profile_id, config_id) DO UPDATE SET
    sort_order = LEAST(profile_configs.sort_order, EXCLUDED.sort_order);

DELETE FROM configs
WHERE id IN (
    SELECT id
    FROM (
        SELECT
            c.id,
            ROW_NUMBER() OVER (
                PARTITION BY c.target_path
                ORDER BY
                    (SELECT COUNT(*) FROM config_snapshots s WHERE s.config_id = c.id) DESC,
                    c.version DESC,
                    c.updated_at DESC,
                    c.created_at ASC,
                    c.id ASC
            ) AS target_rank
        FROM configs c
        WHERE c.target_path IS NOT NULL
    ) ranked
    WHERE target_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS configs_target_path_unique_idx
    ON configs (target_path)
    WHERE target_path IS NOT NULL;
