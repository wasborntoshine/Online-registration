const db = require('./db');
const { logAction } = require('../utils/logger');
const addUser = async (telegramId, name, role = 'client') => {
  try {
    const queryText = `
      INSERT INTO users (telegram_id, name, role)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const values = [telegramId, name, role];
    const res = await db.query(queryText, values);
    logAction(`Добавлен пользователь: ${telegramId} (${name}) с ролью ${role}`);
    return res.rows[0];
  } catch (err) {
    logAction(`Ошибка при добавлении пользователя ${telegramId}: ${err.message}`);
    throw new Error(`Ошибка при добавлении пользователя: ${err.message}`);
  }
};
const getUserByTelegramId = async (telegramId) => {
  try {
    const queryText = 'SELECT * FROM users WHERE telegram_id = $1;';
    const res = await db.query(queryText, [telegramId]);
    return res.rows[0] || null;
  } catch (err) {
    logAction(`Ошибка при получении пользователя ${telegramId}: ${err.message}`);
    throw new Error(`Ошибка при получении пользователя: ${err.message}`);
  }
};
const updateUserRole = async (telegramId, newRole) => {
  try {
    const queryText = `
      UPDATE users
      SET role = $2
      WHERE telegram_id = $1
      RETURNING *;
    `;
    const values = [telegramId, newRole];
    const res = await db.query(queryText, values);
    if (res.rows.length === 0) {
      throw new Error('Пользователь не найден');
    }
    logAction(`Роль пользователя ${telegramId} обновлена на ${newRole}`);
    return res.rows[0];
  } catch (err) {
    logAction(`Ошибка при обновлении роли пользователя ${telegramId}: ${err.message}`);
    throw new Error(`Ошибка при обновлении роли: ${err.message}`);
  }
};
const deleteUser = async (telegramId) => {
  try {
    const queryText = 'DELETE FROM users WHERE telegram_id = $1 RETURNING *;';
    const res = await db.query(queryText, [telegramId]);
    if (res.rows.length === 0) {
      throw new Error('Пользователь не найден');
    }
    logAction(`Пользователь ${telegramId} удалён`);
    return res.rows[0];
  } catch (err) {
    logAction(`Ошибка при удалении пользователя ${telegramId}: ${err.message}`);
    throw new Error(`Ошибка при удалении пользователя: ${err.message}`);
  }
};
const getAllUsers = async () => {
  try {
    const queryText = 'SELECT * FROM users ORDER BY id;';
    const res = await db.query(queryText);
    return res.rows;
  } catch (err) {
    logAction(`Ошибка при получении списка пользователей: ${err.message}`);
    throw new Error(`Ошибка при получении списка пользователей: ${err.message}`);
  }
};
const checkUserRole = async (telegramId) => {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      throw new Error('Пользователь не найден');
    }
    return user.role;
  } catch (err) {
    logAction(`Ошибка при проверке роли пользователя ${telegramId}: ${err.message}`);
    throw new Error(`Ошибка при проверке роли: ${err.message}`);
  }
};
module.exports = {
  addUser,
  getUserByTelegramId,
  updateUserRole,
  deleteUser,
  getAllUsers,
  checkUserRole,
};