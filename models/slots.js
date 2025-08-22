const db = require('../db');
// Валидация формата даты и времени
function validateDateTime(date, time) {
  const dateTime = new Date(`${date}T${time}:00`);
  if (isNaN(dateTime.getTime())) {
    throw new Error('Неверный формат даты или времени. Используйте ГГГГ-ММ-ДД ЧЧ:ММ');
  }
  return true;
}
// Получить свободные слоты по ID специалиста
async function getAvailableSlotsBySpecialist(specialistId) {
  const result = await db.query(
    'SELECT s.id, s.date, s.time, s.is_booked, sp.fullname AS name ' +
    'FROM slots s ' +
    'JOIN specialists sp ON s.specialist_id = sp.id ' +
    'WHERE s.specialist_id = $1 AND s.is_booked = FALSE ' +
    'ORDER BY s.date, s.time',
    [specialistId]
  );
  const slots = result.rows;
  console.log(`Отладка getAvailableSlotsBySpecialist для #${specialistId}:`, JSON.stringify(slots.map(s => ({ id: s.id, date: s.date, time: s.time, is_booked: s.is_booked }))));
  return slots;
}
async function addSlot(specialistId, date, time) {
  const res = await db.query(
    'INSERT INTO slots (specialist_id, date, time, is_booked) VALUES ($1, $2, $3, FALSE) RETURNING id',
    [specialistId, date, time]
  );
  return res.rows[0];
}
async function updateSlot(slotId, date, time) {
  validateDateTime(date, time);
  await db.query(
    'UPDATE slots SET date = $1, time = $2 WHERE id = $3 AND is_booked = FALSE',
    [date, time, slotId]
  );
}
async function deleteSlot(slotId) {
  await db.query(
    'DELETE FROM slots WHERE id = $1 AND is_booked = FALSE',
    [slotId]
  );
}
module.exports = {
  getAvailableSlotsBySpecialist,
  addSlot,
  updateSlot,
  deleteSlot
};