Component({
  properties: {
    eyebrow: { type: String, value: '' },
    title: { type: String, value: '' },
    actionText: { type: String, value: '' }
  },
  methods: {
    onAction() {
      this.triggerEvent('action');
    }
  }
});
