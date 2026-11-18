/**
 * 参数 schema：后端将来可以由 GET /api/train/param-schema 返回同样的结构，
 * 前端按 group → items 渲染控件，新增超参只改这份数据。
 */

export const PARAM_SCHEMA = [
  {
    id: 'data',
    title: '数据集与预处理',
    items: [
      {
        key: 'datasetVersionId',
        label: '数据版本',
        widget: 'select',
        help: '训练用的数据集版本快照；不选则只用内置 MNIST。版本是快照，之后补采集的样本不会自动进来。',
        options: { from: 'datasetVersions' }
      },
      {
        key: 'augment',
        label: '数据增强',
        widget: 'switch',
        help: '旋转 ±15°、平移 0.1。提升手机端真实笔迹的鲁棒性。'
      }
    ]
  },
  {
    id: 'structure',
    title: '网络结构',
    items: [
      {
        key: 'arch',
        label: '结构预设',
        widget: 'select',
        displayOnly: true,
        help: '预设只是起点，选中后仍可逐层修改卷积核数量与全连接宽度。',
        options: { from: 'archPresets' }
      }
    ]
  },
  {
    id: 'hyper',
    title: '训练超参数',
    items: [
      {
        key: 'optimizer',
        label: '优化器',
        widget: 'select',
        displayOnly: true,
        help: 'Adam 收敛快；SGD + 动量泛化略好但需要调学习率。',
        options: [
          { value: 'adam', label: 'Adam' },
          { value: 'sgd', label: 'SGD + 动量' }
        ]
      },
      {
        key: 'momentum',
        label: '动量',
        widget: 'slider',
        min: 0,
        max: 0.99,
        step: 0.01,
        help: '仅 SGD 使用，常用 0.9。',
        dependsOn: { key: 'optimizer', equals: 'sgd' }
      },
      {
        key: 'learningRate',
        label: '学习率',
        widget: 'log-slider',
        min: 1e-5,
        max: 1e-1,
        help: '最重要的参数：太大会发散，太小几乎不更新。Adam 常用 1e-3，SGD 常用 1e-2。'
      },
      {
        key: 'samples',
        label: '样本数',
        widget: 'slider',
        min: 1000,
        max: 60000,
        step: 1000,
        help: '参与训练的样本数量；数据版本会额外并入真实样本。'
      },
      {
        key: 'photoRatio',
        label: '照片增广',
        widget: 'slider',
        min: 0,
        max: 1,
        step: 0.1,
        help: '每轮有多少比例样本做照片风格模拟，提升拍照场景鲁棒性。'
      },
      {
        key: 'batchSize',
        label: '批大小',
        widget: 'segmented',
        options: [16, 32, 64, 128, 256],
        help: '越大越快但显存占用越高，泛化可能略差。'
      },
      {
        key: 'epochs',
        label: '迭代轮数',
        widget: 'slider',
        min: 1,
        max: 100,
        step: 1,
        help: '遍历数据集的遍数；开启早停后可以放心设大一些。'
      },
      {
        key: 'earlyStop',
        label: '早停',
        widget: 'switch',
        help: '验证集连续 N 轮不提升则提前结束，避免过拟合与浪费时间。'
      },
      {
        key: 'patience',
        label: '早停耐心',
        widget: 'slider',
        min: 1,
        max: 10,
        step: 1,
        help: '连续多少轮不提升就停；常用 3。',
        dependsOn: { key: 'earlyStop', equals: true }
      }
    ]
  },
  {
    id: 'runtime',
    title: '运行环境',
    items: [
      {
        key: 'initFrom',
        label: '微调起点',
        widget: 'select',
        help: '从已有模型继续训练通常更稳；选“从零训练”则不用起点权重。',
        options: { from: 'models' }
      },
      {
        key: 'device',
        label: '设备',
        widget: 'select',
        help: '无 GPU 时按 CPU 估算，耗时约为 GPU 的 10 倍。',
        options: [
          { value: 'cpu', label: 'CPU（本机）' },
          { value: 'gpu', label: 'GPU（cuda:0）' }
        ]
      },
      {
        key: 'scheduler',
        label: '学习率调度',
        widget: 'select',
        displayOnly: true,
        help: '仅用于预览：当前训练管线固定常数学习率。',
        options: [
          { value: 'constant', label: '常数' },
          { value: 'cosine', label: '余弦退火' },
          { value: 'step', label: '分段衰减' }
        ]
      },
      {
        key: 'amp',
        label: '混合精度',
        widget: 'switch',
        help: 'GPU 上提速约 1.5 倍，显存约降到 0.6 倍；CPU 不支持。',
        dependsOn: { key: 'device', equals: 'gpu' }
      },
      {
        key: 'seed',
        label: '随机种子',
        widget: 'number',
        min: 0,
        max: 99999,
        help: '相同种子 + 相同配置 = 可复现。'
      }
    ]
  }
]

/** 默认参数（与 schema 对应）。 */
export function defaultConfig() {
  return {
    datasetVersionId: null,
    augment: true,
    arch: 'cnn2',
    optimizer: 'adam',
    momentum: 0.9,
    learningRate: 1e-3,
    samples: 10000,
    photoRatio: 0.5,
    initFrom: null,
    batchSize: 64,
    epochs: 10,
    earlyStop: true,
    patience: 3,
    device: 'cpu',
    scheduler: 'constant',
    amp: false,
    seed: 42
  }
}

/** dependsOn 是否满足（用于显示/隐藏联动控件）。 */
export function isVisible(item, config) {
  if (!item?.dependsOn) return true
  const { key, equals } = item.dependsOn
  return config[key] === equals
}

/** 每个字段的控件类型，页面按这个渲染。 */
export const WIDGETS = ['select', 'segmented', 'log-slider', 'slider', 'number', 'switch']
