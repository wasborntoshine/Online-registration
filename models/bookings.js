const db = require('../db');

async function createBooking(userId, slotId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Проверяем существование слота
    const slotCheck = await client.query('SELECT id FROM slots WHERE id = $1 FOR UPDATE', [slotId]);
    if (slotCheck.rows.length === 0) throw new Error('Слот не существует');

    // Создаём запись
    const booking = await client.query(
      'INSERT INTO bookings (user_id, slot_id, created_at) VALUES ($1, $2, NOW()) RETURNING *',
      [userId, slotId]
    );

    // Обновляем статус слота
    await client.query('UPDATE slots SET is_booked = TRUE WHERE id = $1', [slotId]);

    await client.query('COMMIT');
    return booking.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getBookingsByUser(userId) {
  const bookings = await db.query(`
    SELECT b.id, b.created_at, s.id as slot_id, s.date, s.time, s.specialist_id, sp.specialization
    FROM bookings b
    JOIN slots s ON b.slot_id = s.id
    JOIN specialists sp ON s.specialist_id = sp.id
    WHERE b.user_id = $1
    ORDER BY s.date, s.time
  `, [userId]);
  return bookings.rows;
}

module.exports = {
  createBooking,
  getBookingsByUser
};