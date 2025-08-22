const db = require('../db');
// Получить все активные заявки
async function getActiveFeedbackRequests() {
  try {
    const res = await db.query(
      'SELECT id, message, status FROM feedback_requests WHERE status != $1 ORDER BY id DESC',
      ['закрыта']
    );
    return res.rows;
  } catch (err) {
    console.error('Ошибка в getActiveFeedbackRequests:', err);
    return [];
  }
}
// Установить ответ администратора
async function setAdminResponse(id, response) {
  try {
    await db.query(
      'UPDATE feedback_requests SET admin_response = $1, status = $2 WHERE id = $3',
      [response, 'в обработке', id]
    );
  } catch (err) {
    console.error('Ошибка в setAdminResponse:', err);
  }
}
// Закрыть заявку
async function closeFeedbackRequest(id) {
  try {
    await db.query(
      'UPDATE feedback_requests SET status = $1 WHERE id = $2',
      ['закрыта', id]
    );
  } catch (err) {
    console.error('Ошибка в closeFeedbackRequest:', err);
  }
}
// Получить ID пользователя по заявке
async function getFeedbackUser(requestId) {
  try {
    const res = await db.query(
      'SELECT user_id FROM feedback_requests WHERE id = $1',
      [requestId]
    );
    return res.rows[0]?.user_id || null;
  } catch (err) {
    console.error('Ошибка в getFeedbackUser:', err);
    return null;
  }
}
module.exports = {
  getActiveFeedbackRequests,
  setAdminResponse,
  closeFeedbackRequest,
  getFeedbackUser
};
