Component({
  properties: {
    title: { type: String, value: '这里还空着' },
    description: { type: String, value: '新的内容，很快就会出现在这里。' },
    actionText: { type: String, value: '' }
  },
  methods: {
    onAction() {
      this.triggerEvent('action');
    }
  }
});
