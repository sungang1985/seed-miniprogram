const COLLECTION = 'share_rooms';

function missingDocument(error) {
  const text = String(error && (error.errCode || error.code || '')) + ' ' +
    String(error && (error.errMsg || error.message || ''));
  return /DOCUMENT_NOT_(?:EXIST|FOUND)|document[^\n]*(?:does not exist|not exist|not found)/i.test(text);
}

/** The WeChat server SDK uses { data } write arguments; direct client access is denied. */
function createCloudRepository(database) {
  return {
    mutate(roomId, update) {
      return database.runTransaction(async (transaction) => {
        const document = transaction.collection(COLLECTION).doc(roomId);
        let room = null;
        try {
          const response = await document.get();
          room = Array.isArray(response.data) ? response.data[0] || null : response.data || null;
        } catch (error) {
          if (!missingDocument(error)) throw error;
        }
        const result = update(room);
        if (result.room) {
          const value = Object.assign({}, result.room);
          delete value._id;
          await document.set({ data: value });
        }
        return result.value;
      });
    }
  };
}

module.exports = { createCloudRepository };
