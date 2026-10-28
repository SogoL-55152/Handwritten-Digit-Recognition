const { clearSession } = require('./session')

function authHeader() {
  const token = getApp().globalData.token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function handleUnauthorized() {
  clearSession()
  wx.reLaunch({ url: '/pages/login/login' })
}

function request({ url, method = 'GET', data, header = {} }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: getApp().globalData.baseUrl + url,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        ...authHeader(),
        ...header
      },
      success(res) {
        const body = res.data
        if (body && body.code === 0) {
          resolve(body.data)
          return
        }
        if (body && body.code === 401) {
          handleUnauthorized()
        }
        wx.showToast({
          title: (body && body.message) || '请求失败',
          icon: 'none'
        })
        reject(body)
      },
      fail(error) {
        wx.showToast({ title: '网络异常，请检查服务地址', icon: 'none' })
        reject(error)
      }
    })
  })
}

function upload({ url, filePath, name = 'file' }) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: getApp().globalData.baseUrl + url,
      filePath,
      name,
      header: authHeader(),
      success(res) {
        let body = null
        try {
          body = JSON.parse(res.data)
        } catch (error) {
          body = null
        }
        if (body && body.code === 0) {
          resolve(body.data)
          return
        }
        if (body && body.code === 401) {
          handleUnauthorized()
        }
        wx.showToast({
          title: (body && body.message) || '识别失败',
          icon: 'none'
        })
        reject(body)
      },
      fail(error) {
        wx.showToast({ title: '上传失败，请检查后端服务', icon: 'none' })
        reject(error)
      }
    })
  })
}

module.exports = {
  request,
  upload
}
