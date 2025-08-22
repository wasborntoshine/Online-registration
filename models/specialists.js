const db = require('../db');

async function getAllSpecialists() {
  try {
    const result = await db.query(`
      SELECT specialists.id, users.name, specialists.specialization
      FROM specialists
      JOIN users ON specialists.user_id = users.id
      ORDER BY users.name
    `);
    return result.rows;
  } catch (err) {
    console.error('Ошибка в getAllSpecialists:', err);
    return [];
  }
}

async function insertSpecialist(userId, specialization, description) {
  const res = await db.query(
    'INSERT INTO specialists (user_id, specialization, description) VALUES ($1, $2, $3) RETURNING *',
    [userId, specialization, description]
  );
  return res.rows[0];
}

module.exports = {
  getAllSpecialists,
  insertSpecialist
};