Page({
  data: {
    submitting: false,
    name: '',
    count: 1,
    notificationsEnabled: true,
    lastAction: '试着点击下面的操作',
    items: []
  },

  onUnload() {
    if (this._submitTimer) clearTimeout(this._submitTimer);
  },

  onPrimaryTap() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    this._submitTimer = setTimeout(() => {
      this.setData({ submitting: false });
      wx.showToast({ title: '操作完成', icon: 'success' });
      this._submitTimer = null;
    }, 800);
  },

  onNameInput(event) {
    this.setData({ name: event.detail.value });
  },

  onSubmitName() {
    const name = this.data.name.trim();
    if (!name) {
      wx.showToast({ title: '先写下你的名字吧', icon: 'none' });
      return;
    }
    this.setData({ name });
    wx.showToast({ title: `你好，${name}`, icon: 'none' });
  },

  onCountChange(event) {
    const delta = Number(event.currentTarget.dataset.delta);
    if (delta !== -1 && delta !== 1) return;
    this.setData({ count: Math.max(0, Math.min(99, this.data.count + delta)) });
  },

  onSwitchChange(event) {
    this.setData({ notificationsEnabled: event.detail.value });
  },

  onToastTap() {
    this.setData({ lastAction: 'Toast · 轻提示已展示' });
    wx.showToast({ title: '你的想法，值得被看见', icon: 'none' });
  },

  onModalTap() {
    wx.showModal({
      title: '准备好开始了吗？',
      content: '这是一个原生确认弹窗。每一次交互，都可以从这里开始。',
      confirmText: '准备好了',
      confirmColor: '#07a66a',
      cancelText: '再想一想',
      success: (result) => {
        this.setData({ lastAction: result.confirm ? 'Modal · 你选择了确认' : 'Modal · 你选择了取消' });
      }
    });
  },

  onAddItems() {
    this.setData({ items: [{ id: 'idea', title: '第一个好想法', description: '从这里出发，写下你的故事。' }, { id: 'action', title: '现在就开始', description: '把灵感变成可以触摸的体验。' }] });
  },

  onResetItems() {
    this.setData({ items: [] });
  }
});
