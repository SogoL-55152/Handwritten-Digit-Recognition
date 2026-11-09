-- Switch the single trusted public baseline to the canvas-domain model.
-- The W1 row is updated in place so existing workspaces keep default_model_id=1.
-- accuracy stays on the MNIST-test convention (comparable with the previous row);
-- the synthetic canvas-domain number lives in description and is not an online metric.
UPDATE t_v2_model
SET name = 'MNIST CNN canvas-aug',
    version = 'w2-canvas-aug-3epoch',
    accuracy = 0.989,
    accuracy_dataset = 'MNIST test',
    description = 'Canvas-domain baseline trained on pipeline-consistent geometry plus canvas augmentation; MNIST test 0.989, synthetic canvas-simulated 0.982, not real board accuracy'
WHERE id = 1 AND scope = 'PUBLIC' AND external_id = 'mnist-cnn-w1';
