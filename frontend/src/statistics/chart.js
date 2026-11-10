/** 训练曲线与统计图表的 ECharts 配置（纯函数，便于单测）。 */
export function trainingCurveOption(history = [], title = '训练过程') {
  const epochs = history.map((item) => `第 ${item.epoch} 轮`)
  const percent = (value) => (typeof value === 'number' ? Math.round(value * 10000) / 100 : null)
  return {
    title: { text: title, left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, data: ['损失', 'MNIST', '画板模拟', '照片模拟'] },
    grid: { left: 48, right: 24, top: 40, bottom: 48 },
    xAxis: { type: 'category', data: epochs },
    yAxis: [
      { type: 'value', name: '损失', position: 'left' },
      { type: 'value', name: '准确率 %', position: 'right', min: 0, max: 100 }
    ],
    series: [
      { name: '损失', type: 'line', smooth: true, yAxisIndex: 0, data: history.map((item) => item.loss) },
      { name: 'MNIST', type: 'line', smooth: true, yAxisIndex: 1, data: history.map((item) => percent(item.raw_mnist)) },
      { name: '画板模拟', type: 'line', smooth: true, yAxisIndex: 1, data: history.map((item) => percent(item.canvas_simulated)) },
      { name: '照片模拟', type: 'line', smooth: true, yAxisIndex: 1, data: history.map((item) => percent(item.photo_simulated)) }
    ]
  }
}

export function dailyOption(series, title = '每日识别量') {
  return {
    title: { text: title, left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, data: ['请求', '返回结果', '拒识', '失败'] },
    grid: { left: 44, right: 20, top: 40, bottom: 48 },
    xAxis: { type: 'category', data: series.dates },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      { name: '请求', type: 'bar', stack: 'day', data: series.total },
      { name: '返回结果', type: 'bar', stack: 'day', data: series.accepted },
      { name: '拒识', type: 'bar', stack: 'day', data: series.declined },
      { name: '失败', type: 'bar', stack: 'day', data: series.failed }
    ]
  }
}

export function modelShareOption(rows) {
  return {
    title: { text: '模型使用分布', left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'item' },
    series: [{
      type: 'pie',
      radius: ['40%', '68%'],
      data: rows.map((row) => ({ name: row.version, value: row.total }))
    }]
  }
}
