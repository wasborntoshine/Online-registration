const db = require('../db');

async function getServicesBySpecialist(specialistId) {
  try {
    const res = await db.query(
      'SELECT id, name FROM services WHERE specialist_id = $1 ORDER BY name',
      [specialistId]
    );
    return res.rows;
  } catch (err) {
    console.error('Ошибка в getServicesBySpecialist:', err);
    return [];
  }
}

async function addService(specialistId, name) {
  await db.query('INSERT INTO services (specialist_id, name) VALUES ($1, $2)', [specialistId, name]);
}

async function updateService(serviceId, newName) {
  await db.query('UPDATE services SET name = $1 WHERE id = $2', [newName, serviceId]);
}

module.exports = {
  getServicesBySpecialist,
  addService,
  updateService
};