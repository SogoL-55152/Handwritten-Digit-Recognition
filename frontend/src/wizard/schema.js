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
        detail: '作用：指定训练用哪一份数据快照（数据集 + 版本），保证这次训练可复现。\n常规：先在「数据集」页生成版本，再这里选中它；不确定就先不选，用内置 MNIST 跑通流程。\n注意：版本是快照，之后新导入的样本不会自动进来，要重新生成版本。',
        options: { from: 'datasetVersions' }
      },
      {
        key: 'augment',
        label: '数据增强',
        widget: 'switch',
        help: '旋转 ±15°、平移 0.1。提升手机端真实笔迹的鲁棒性。',
        detail: '作用：训练时随机旋转 ±15°、平移 0.1，模拟真实手写的位置与角度偏差。\n常规：手机/画板数据保持开启；如果训练集本身已经做过大量增广，可以关掉。\n注意：增广越强越难收敛，必要时多训几轮。',
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
        detail: '作用：选择网络结构预设（2Conv / 3Conv 等），决定参数量与表达能力。\n常规：手写数字用默认 CNN 2Conv 足够（42 万参数）；要更高精度可换更深的预设。\n注意：当前训练管线的结构固定，这一项**只参与估算**，不会真的改变网络。',
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
        detail: '作用：决定参数更新方式。Adam 自适应学习率、收敛快；SGD + 动量泛化有时更好但更依赖调参。\n常规：默认 Adam；只有在 Adam 过拟合或想冲极限精度时才试 SGD。\n注意：当前训练管线固定 Adam，此项**只参与估算**。',
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
        detail: '作用：SGD 的动量项，累积历史梯度、减少震荡。\n常规：0.9（几乎默认值）；0.99 更平滑但可能冲过头。\n注意：仅在优化器选 SGD 时有效，且当前不生效（仅估算）。',
        dependsOn: { key: 'optimizer', equals: 'sgd' }
      },
      {
        key: 'learningRate',
        label: '学习率',
        widget: 'log-slider',
        min: 1e-5,
        max: 1e-1,
        help: '最重要的参数：太大会发散，太小几乎不更新。Adam 常用 1e-3，SGD 常用 1e-2。',
        detail: '作用：每次更新的步长，是影响训练成败最关键的参数。\n常规：从零训练 Adam 用 1e-3；微调已有模型用 1e-4 ~ 5e-4；SGD 用 1e-2。\n注意：太大表现为 loss 震荡/变 NaN，太小表现为 loss 几乎不动。',
      },
      {
        key: 'samples',
        label: '样本数',
        widget: 'slider',
        min: 1000,
        max: 60000,
        step: 1000,
        help: '参与训练的样本数量；数据版本会额外并入真实样本。',
        detail: '作用：这一轮训练用多少张图（从训练集里取）。\n常规：先用 10,000 跑通；数据版本样本多、想冲精度再用 30,000~60,000。\n注意：样本越多越慢（线性增长），也会影响「实时估算」的耗时。',
      },
      {
        key: 'photoRatio',
        label: '照片增广',
        widget: 'slider',
        min: 0,
        max: 1,
        step: 0.1,
        help: '每轮有多少比例样本做照片风格模拟，提升拍照场景鲁棒性。',
        detail: '作用：每轮有多少比例的样本做「照片风格模拟」（光照、噪声、模糊），提升拍照场景鲁棒性。\n常规：画板为主用 0.3；拍照为主用 0.6~0.8；纯印刷体可设 0。\n注意：过高会让画板场景掉点。',
      },
      {
        key: 'batchSize',
        label: '批大小',
        widget: 'segmented',
        options: [16, 32, 64, 128, 256],
        help: '越大越快但显存占用越高，泛化可能略差。',
        detail: '作用：一次前向/反向用多少样本，影响速度、显存与梯度稳定性。\n常规：CPU 用 64；GPU 可上 128/256。\n注意：批越大，等效学习率可以略调大。',
      },
      {
        key: 'epochs',
        label: '迭代轮数',
        widget: 'slider',
        min: 1,
        max: 100,
        step: 1,
        help: '遍历数据集的遍数；开启早停后可以放心设大一些。',
        detail: '作用：把训练集完整遍历几遍。\n常规：从零训练 3~5 轮；微调 3 轮左右；开了早停可以放心设大（如 10）。\n注意：轮数过多且无早停容易过拟合。',
      },
      {
        key: 'earlyStop',
        label: '早停',
        widget: 'switch',
        help: '验证集连续 N 轮不提升则提前结束，避免过拟合与浪费时间。',
        detail: '作用：验证指标连续 N 轮不提升就提前结束，省时间、防过拟合。\n常规：开启（默认开），配合耐心 2~3。\n注意：判定依据是画板模拟准确率，不是训练 loss。',
      },
      {
        key: 'patience',
        label: '早停耐心',
        widget: 'slider',
        min: 1,
        max: 10,
        step: 1,
        help: '连续多少轮不提升就停；常用 3。',
        detail: '作用：允许连续多少轮「没有提升」才停。\n常规：2~3；数据噪声大用 4~5。\n注意：设 1 很容易因波动提前停；设太大等于没开早停。',
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
        detail: '作用：从哪个已有模型继续训练（微调）。\n常规：先用当前生效模型微调；新场景差异大时选「从零训练」。\n注意：微调的学习率要比从零训练小一个量级。',
        options: { from: 'models' }
      },
      {
        key: 'trainFrom',
        label: '冻结策略',
        widget: 'select',
        help: '决定哪些层参与更新：冻结越多越稳、越快，但能学的新东西越少。',
        detail: '作用：控制从哪一层开始训练。冻结的层保持起点权重不变，只更新后面的层。\n常规：样本少（<2000）选「冻结卷积层，只训全连接」；只换分类习惯选「只训最后一层（fc2）」；数据多且场景差异大选「不冻结」。\n注意：fc2（最后一层）必须可训练；不选微调起点却冻结卷积层，效果通常不好。',
        options: [
          { value: 'all', label: '不冻结（全量微调）' },
          { value: 'fc1', label: '冻结卷积层，只训全连接' },
          { value: 'fc2', label: '只训最后一层（fc2）' },
          { value: 'custom', label: '自定义' }
        ]
      },
      {
        key: 'trainableLayers',
        label: '可训练层',
        widget: 'layers',
        help: '勾选参与训练的层；fc2 必须保留。',
        detail: '作用：自定义哪些参数块参与更新。\n层含义：conv1/conv2 是特征提取，fc1 是 128 维全连接，fc2 是 10 类输出层。\n常规：自定义一般用于「只冻 conv2」这类折中；fc2 必须勾选。',
        dependsOn: { key: 'trainFrom', equals: 'custom' }
      },
      {
        key: 'device',
        label: '设备',
        widget: 'select',
        help: '无 GPU 时按 CPU 估算，耗时约为 GPU 的 10 倍。',
        detail: '作用：在 CPU 还是 GPU 上训练。\n常规：本机没有可用 GPU 就选 CPU；有显卡选 GPU。\n注意：估算里的耗时按 CPU 算，GPU 大约快 10 倍。',
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
        detail: '作用：学习率随训练进度变化的策略（常数/余弦/分段）。\n常规：短训练用常数；长训练用余弦退火更稳。\n注意：当前训练管线的学习率**固定为常数**，这一项只用于预览曲线。',
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
        detail: '作用：混合精度训练（FP16），GPU 上更快、更省显存。\n常规：GPU 且显存紧张时开；CPU 无效。\n注意：当前训练管线未启用，只参与估算。',
        dependsOn: { key: 'device', equals: 'gpu' }
      },
      {
        key: 'seed',
        label: '随机种子',
        widget: 'number',
        min: 0,
        max: 99999,
        help: '相同种子 + 相同配置 = 可复现。',
        detail: '作用：随机种子，控制初始化、增广、采样的随机性。\n常规：固定一个值（如 42）便于复现；做对比实验时保持一致。\n注意：换种子会有小幅波动，比较模型时应固定。',
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
    trainFrom: 'all',
    trainableLayers: ['conv1', 'conv2', 'fc1', 'fc2'],
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
export const WIDGETS = ['select', 'segmented', 'log-slider', 'slider', 'number', 'switch', 'layers']
