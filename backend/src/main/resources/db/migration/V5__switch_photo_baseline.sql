-- Switch the trusted public baseline to the canvas+photo model trained on the
-- adaptive-mnist-v2 preprocessing. The row is updated in place so existing
-- workspaces keep default_model_id = 1.
-- accuracy stays on the MNIST-test convention; the canvas/photo simulated
-- numbers live in description and are not online metrics.
UPDATE t_v2_model
SET name = 'MNIST CNN canvas+photo',
    version = 'w2-canvas-photo-3epoch',
    preprocess_version = 'adaptive-mnist-v2',
    accuracy = 0.977,
    accuracy_dataset = 'MNIST test',
    description = 'Canvas+photo baseline: adaptive background normalisation shared with training, canvas and photo augmentation, EMNIST writer variety; MNIST 0.977, canvas-simulated 0.991, photo-simulated 0.840, EMNIST unseen writers 0.985, not real board or album accuracy'
WHERE id = 1 AND scope = 'PUBLIC' AND external_id = 'mnist-cnn-w1';
