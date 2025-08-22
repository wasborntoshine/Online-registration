const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs'); // Для логирования
require('dotenv').config();
const db = require('./db');

// Модели
const {
  getAllSpecialists, insertSpecialist
} = require('./models/specialists');
const {
  getServicesBySpecialist, addService, updateService
} = require('./models/services');
const {
  getAvailableSlotsBySpecialist, addSlot, updateSlot, deleteSlot
} = require('./models/slots');
const {
  createBooking, getBookingsByUser
} = require('./models/bookings');
const {
  getActiveFeedbackRequests, setAdminResponse,
  closeFeedbackRequest, getFeedbackUser
} = require('./models/feedback');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Временные хранилища для админов
const adminTemp = {};
const addServiceTemp = {};
const addSlotTemp = {};
const editSlotTemp = {}; // Для хранения данных редактирования слота
const editServiceTemp = {}; // Для хранения данных редактирования услуг
const paginationTemp = {}; // Для хранения данных пагинации

// Глобальный обработчик ошибок
process.on('uncaughtException', (err) => {
  console.error('Необработанная ошибка:', err);
  logAction(`Необработанная ошибка: ${err.message}`);
  notifyAdmins(`🚨 Произошла необработанная ошибка: ${err.message}`);
});

// Функция логирования действий
function logAction(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync('logs.txt', logMessage);
}

// Функция уведомления администраторов
async function notifyAdmins(message) {
  try {
    const admins = await db.query('SELECT telegram_id FROM users WHERE role = $1', ['admin']);
    for (const admin of admins.rows) {
      if (admin.telegram_id) {
        await bot.sendMessage(admin.telegram_id, message);
      }
    }
  } catch (err) {
    console.error('Ошибка при отправке уведомления администратору:', err);
    logAction(`Ошибка при отправке уведомления администратору: ${err.message}`);
  }
}

// Валидация формата даты и времени
function validateDateTime(date, time) {
  const dateTime = new Date(`${date}T${time}:00`);
  if (isNaN(dateTime.getTime())) {
    throw new Error('Неверный формат даты или времени. Используйте ГГГГ-ММ-ДД ЧЧ:ММ');
  }
  return true;
}

// Функция форматирования даты
function formatDateTime(dateStr, timeStr) {
  if (typeof dateStr !== 'string' || !dateStr.trim() || typeof timeStr !== 'string' || !timeStr.trim()) {
    logAction(`Ошибка: пустые или некорректные данные - dateStr=${dateStr}, timeStr=${timeStr}`);
    return 'Некорректная дата и время';
  }
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    if (!year || !month || !day || year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) {
      logAction(`Некорректный формат даты: ${dateStr}`);
      return 'Некорректная дата';
    }
    const formattedDate = `${day.toString().padStart(2, '0')}-${month.toString().padStart(2, '0')}-${year}`;

    const timeParts = timeStr.split(':');
    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);
    if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      logAction(`Некорректный формат времени: ${timeStr}`);
      return 'Некорректное время';
    }
    const formattedTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    return `${formattedDate} ${formattedTime}`;
  } catch (err) {
    logAction(`Ошибка в formatDateTime: ${err.message}, dateStr=${dateStr}, timeStr=${timeStr}`);
    return 'Некорректная дата и время';
  }
}

// Функция проверки и закрытия истекших записей
async function checkExpiredBookings() {
  try {
    const bookings = await db.query(`
      SELECT b.id, b.user_id, s.id as slot_id, s.date, s.time, s.specialist_id
      FROM bookings b
      JOIN slots s ON b.slot_id = s.id
      WHERE s.is_booked = TRUE
    `);
    const now = new Date();

    for (const booking of bookings.rows) {
      const slotDateTime = new Date(`${booking.date}T${booking.time}:00`);
      if (now > slotDateTime) {
        await db.query(
          'INSERT INTO booking_history (user_id, slot_id, specialist_id, created_at, closed_at) VALUES ($1, $2, $3, $4, $5)',
          [booking.user_id, booking.slot_id, booking.specialist_id, booking.created_at || now, now]
        );
        await db.query('DELETE FROM bookings WHERE id = $1', [booking.id]);
        await db.query('UPDATE slots SET is_booked = FALSE WHERE id = $1', [booking.slot_id]);
        const user = await db.query('SELECT telegram_id FROM users WHERE id = $1', [booking.user_id]);
        if (user.rows[0]?.telegram_id) {
          bot.sendMessage(user.rows[0].telegram_id, '⏰ Ваша запись истекла и была автоматически закрыта.');
        }
        logAction(`Запись #${booking.id} истекла и была закрыта.`);
      }
    }
  } catch (err) {
    console.error('Ошибка при проверке истекших записей:', err);
    logAction(`Ошибка при проверке истекших записей: ${err.message}`);
    notifyAdmins(`🚨 Ошибка при проверке истекших записей: ${err.message}`);
  }
}

// Функция отправки напоминаний
async function sendReminders() {
  try {
    const bookings = await db.query(`
      SELECT b.id, b.user_id, s.id as slot_id, s.date, s.time, sp.specialization
      FROM bookings b
      JOIN slots s ON b.slot_id = s.id
      JOIN specialists sp ON s.specialist_id = sp.id
      WHERE s.is_booked = TRUE
    `);
    const now = new Date();

    for (const booking of bookings.rows) {
      const slotDateTime = new Date(`${booking.date}T${booking.time}:00`);
      const timeDiffHours = (slotDateTime - now) / (1000 * 60 * 60);

      if (timeDiffHours > 23 && timeDiffHours <= 24) {
        const user = await db.query('SELECT telegram_id FROM users WHERE id = $1', [booking.user_id]);
        if (user.rows[0]?.telegram_id) {
          bot.sendMessage(user.rows[0].telegram_id,
            `⏰ Напоминание: у вас запись завтра в ${formatDateTime(booking.date, booking.time)} к специалисту (${booking.specialization}).`);
        }
        logAction(`Отправлено напоминание за 24 часа для записи #${booking.id}.`);
      } else if (timeDiffHours > 0 && timeDiffHours <= 1) {
        const user = await db.query('SELECT telegram_id FROM users WHERE id = $1', [booking.user_id]);
        if (user.rows[0]?.telegram_id) {
          bot.sendMessage(user.rows[0].telegram_id,
            `⏰ Напоминание: у вас запись через час в ${formatDateTime(booking.date, booking.time)} к специалисту (${booking.specialization}).`);
        }
        logAction(`Отправлено напоминание за 1 час для записи #${booking.id}.`);
      }
    }
  } catch (err) {
    console.error('Ошибка при отправке напоминаний:', err);
    logAction(`Ошибка при отправке напоминаний: ${err.message}`);
    notifyAdmins(`🚨 Ошибка при отправке напоминаний: ${err.message}`);
  }
}

// Функция управления слотами
async function manageSlots() {
  try {
    const now = new Date();
    const specialists = await getAllSpecialists();

    // Удаление истекших слотов с запасом в 5 минут
    const currentDate = now.toISOString().split('T')[0];
    let currentHours = parseInt(now.toTimeString().split(' ')[0].split(':')[0]);
    let currentMinutes = parseInt(now.toTimeString().split(' ')[0].split(':')[1]);
    currentMinutes += 5; // Добавляем 5 минут
    if (currentMinutes >= 60) {
      currentHours += 1;
      currentMinutes -= 60;
    }
    const currentTime = `${currentHours.toString().padStart(2, '0')}:${currentMinutes.toString().padStart(2, '0')}`;
    const deletedSlots = await db.query(
      'DELETE FROM slots WHERE date < $1 OR (date = $2 AND time < $3) RETURNING id, date, time',
      [currentDate, currentDate, currentTime]
    );
    if (deletedSlots.rows.length > 0) {
      deletedSlots.rows.forEach(slot => {
        logAction(`Удалён слот #${slot.id} на ${formatDateTime(slot.date, slot.time)} как истёкший.`);
      });
    }

    // Добавление новых слотов на неделю вперёд
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() + 1); // Начинаем с завтра
    const timesOfDay = ['10:00', '14:00', '18:00']; // Три слота в день

    for (let i = 0; i < 7; i++) {
      const newDate = new Date(startDate);
      newDate.setDate(startDate.getDate() + i);
      const dayOfWeek = newDate.getDay(); // 0 - воскресенье, 6 - суббота
      if (dayOfWeek === 0 || dayOfWeek === 6) continue; // Пропускаем выходные

      const dateStr = newDate.toISOString().split('T')[0];

      for (const specialist of specialists) {
        for (const timeStr of timesOfDay) {
          const existingSlot = await db.query(
            'SELECT id FROM slots WHERE specialist_id = $1 AND date = $2 AND time = $3',
            [specialist.id, dateStr, timeStr]
          );
          if (existingSlot.rows.length === 0) {
            const newSlot = await addSlot(specialist.id, dateStr, timeStr);
            logAction(`Добавлен новый слот #${newSlot.id} для специалиста #${specialist.id} на ${dateStr} ${timeStr}.`);
          }
        }
      }
    }
  } catch (err) {
    console.error('Ошибка при управлении слотами:', err);
    logAction(`Ошибка при управлении слотами: ${err.message}`);
    notifyAdmins(`🚨 Ошибка при управлении слотами: ${err.message}`);
  }
}

// Запуск периодической проверки каждую 1 минуту
setInterval(() => {
  checkExpiredBookings();
  manageSlots();
  sendReminders();
}, 1 * 60 * 1000);

// Обработчик команды /start
async function handleStart(msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const name = msg.from.first_name;

  try {
    let user = await db.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    if (user.rows.length === 0) {
      await db.query('INSERT INTO users (telegram_id, name) VALUES ($1, $2)', [telegramId, name]);
      user = await db.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    }

    const role = user.rows[0].role || 'client';
    const keyboard = {
      inline_keyboard: [
        [{ text: '📅 Записаться', callback_data: 'book' }],
        [{ text: '👨‍⚕️ Специалисты', callback_data: 'book' }],
        [{ text: '✉️ Обратная связь', callback_data: 'feedback' }],
        [{ text: '📋 Мои записи', callback_data: 'my_bookings_view' }],
        ...(role === 'admin' ? [[{ text: '⚙️ Админ-панель', callback_data: 'admin_panel' }]] : []),
        ...(role === 'specialist' ? [
          [{ text: '🗓 Мои слоты', callback_data: 'my_slots' }],
          [{ text: '👥 Мои записи', callback_data: 'my_clients' }]
        ] : [])
      ]
    };

    await bot.sendMessage(chatId, `👋 Привет, ${name}! Чем могу помочь?`, {
      reply_markup: keyboard
    });
    logAction(`Пользователь ${name} (ID: ${telegramId}) запустил бота.`);
  } catch (err) {
    console.error('/start error:', err);
    bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте позже.');
    logAction(`Ошибка /start для пользователя ${telegramId}: ${err.message}`);
  }
}

// Обработчик команды /admin
async function handleAdmin(msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  try {
    const user = await db.query('SELECT role FROM users WHERE telegram_id = $1', [telegramId]);
    if (user.rows[0]?.role === 'admin') {
      bot.sendMessage(chatId, '✅ Вы в режиме администратора.');
      bot.emit('callback_query', {
        data: 'admin_panel',
        from: msg.from,
        message: msg
      });
      logAction(`Пользователь ${telegramId} вошёл в режим администратора.`);
    } else {
      bot.sendMessage(chatId, '⛔ У вас нет прав администратора.');
      logAction(`Пользователь ${telegramId} попытался войти в режим администратора, но доступ запрещён.`);
    }
  } catch (err) {
    console.error('/admin error:', err);
    bot.sendMessage(chatId, 'Ошибка при переходе в режиме администратора.');
    logAction(`Ошибка /admin для пользователя ${telegramId}: ${err.message}`);
  }
}

// Новая команда /reset для сброса сессии
bot.onText(/\/reset/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  logAction(`Пользователь ${telegramId} инициировал сброс сессии.`);

  try {
    await bot.deleteMessage(chatId, msg.message_id);
    await bot.sendMessage(chatId, '✅ Сессия сброшена. Пожалуйста, начните заново с /start.');
  } catch (err) {
    logAction(`Ошибка при удалении сообщения для ${telegramId}: ${err.message}`);
    await bot.sendMessage(chatId, '⚠️ Не удалось удалить старые сообщения. Пожалуйста, удалите их вручную и используйте /start.');
  }
});

// Обработчик просмотра записей
async function handleMyBookingsView(chatId, telegramId) {
  try {
    const user = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId]);
    const userId = user.rows[0].id;
    const bookings = await getBookingsByUser(userId);

    if (!bookings.length) return bot.sendMessage(chatId, 'У вас нет активных записей.');

    for (const b of bookings) {
      const slotDateTime = new Date(`${b.date}T${b.time}:00`);
      const now = new Date();
      if (now > slotDateTime) {
        await db.query(
          'INSERT INTO booking_history (user_id, slot_id, specialist_id, created_at, closed_at) VALUES ($1, $2, $3, $4, $5)',
          [userId, b.slot_id, b.specialist_id, b.created_at || now, now]
        );
        await db.query('DELETE FROM bookings WHERE id = $1', [b.id]);
        await db.query('UPDATE slots SET is_booked = FALSE WHERE id = $1', [b.slot_id]);
        bot.sendMessage(chatId, `⏰ Запись ${formatDateTime(b.date, b.time)} истекла и была закрыта.`);
        logAction(`Запись #${b.id} пользователя ${telegramId} истекла и была закрыта.`);
      } else {
        bot.sendMessage(chatId,
          `📅 Запись: ${formatDateTime(b.date, b.time)}\nСпециалист: ${b.specialization}`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '❌ Отменить', callback_data: `cancel_booking_${b.id}` }]
              ]
            }
          });
      }
    }
    logAction(`Пользователь ${telegramId} просмотрел свои записи.`);
  } catch (err) {
    console.error('/mybookings_view error:', err);
    bot.sendMessage(chatId, 'Ошибка загрузки записей.');
    logAction(`Ошибка /mybookings_view для пользователя ${telegramId}: ${err.message}`);
  }
}

// Обработчик команды /mybookings (для совместимости)
async function handleMyBookings(msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  return handleMyBookingsView(chatId, telegramId);
}

// Обработчик для "Мои слоты"
async function handleMySlots(chatId, telegramId, page = 0, messageId = null) {
  const user = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId]);
  const specialistRes = await db.query('SELECT id FROM specialists WHERE user_id = $1', [user.rows[0].id]);
  if (!specialistRes.rows.length) return bot.sendMessage(chatId, 'Вы не зарегистрированы как специалист.');

  const specialistId = specialistRes.rows[0].id;
  const slots = await db.query(
    'SELECT id, date, time, is_booked FROM slots WHERE specialist_id = $1 ORDER BY date, time',
    [specialistId]
  );
  if (!slots.rows.length) return bot.sendMessage(chatId, 'У вас нет слотов.');

  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const [currentHours, currentMinutes] = now.toTimeString().split(' ')[0].split(':');
  const currentTime = `${currentHours}:${currentMinutes}`;

  logAction(`Слоты до фильтрации для специалиста #${specialistId}: ${JSON.stringify(slots.rows.map(s => ({ id: s.id, date: s.date, time: s.time, is_booked: s.is_booked })))}`);

  const filteredSlots = [];
  for (const slot of slots.rows) {
    const slotFormattedDate = slot.date;
    const slotFormattedTime = slot.time.slice(0, 5);
    if (
      slotFormattedDate > currentDate ||
      (slotFormattedDate === currentDate && slotFormattedTime >= currentTime)
    ) {
      const isBooked = slot.is_booked === 't' || slot.is_booked === true;
      filteredSlots.push({ ...slot, is_booked: isBooked });
    }
  }

  if (!filteredSlots.length) return bot.sendMessage(chatId, 'Нет доступных слотов на будущее.');

  const slotsPerPage = 5;
  const totalPages = Math.ceil(filteredSlots.length / slotsPerPage);
  page = Math.max(0, Math.min(page, totalPages - 1));

  const startIndex = page * slotsPerPage;
  const endIndex = Math.min(startIndex + slotsPerPage, filteredSlots.length);
  const currentSlots = filteredSlots.slice(startIndex, endIndex);

  let message = `Онлайн запись к специалисту, [${new Date().toLocaleString('ru-RU')}] (страница ${page + 1} из ${totalPages})`;
  for (const slot of currentSlots) {
    const isBooked = slot.is_booked;
    const status = isBooked ? 'Занят' : 'Свободен';
    message += `\n📅 ${formatDateTime(slot.date, slot.time)} — ${status}`;
  }

  const keyboard = {
    inline_keyboard: [
      ...currentSlots.map(slot => {
        const isBooked = slot.is_booked;
        return [
          ...(isBooked ? [] : [
            { text: '✏️ Редактировать', callback_data: `edit_slot_${slot.id}` },
            { text: '🗑 Удалить', callback_data: `delete_slot_${slot.id}` }
          ])
        ].filter(row => row.length > 0);
      }),
      totalPages > 1 ? [
        ...(page > 0 ? [{ text: '⬅️ Назад', callback_data: `my_slots_page_${page - 1}` }] : []),
        ...(page < totalPages - 1 ? [{ text: '➡️ Далее', callback_data: `my_slots_page_${page + 1}` }] : [])
      ] : []
    ]
  };

  if (messageId) {
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: keyboard
    });
  } else {
    const sentMessage = await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    messageId = sentMessage.message_id;
  }

  paginationTemp[chatId] = { specialistId, page, messageId };
  logAction(`Специалист ${telegramId} просмотрел свои слоты (страница ${page + 1}/${totalPages}): ${JSON.stringify(currentSlots.map(s => ({ id: s.id, date: s.date, time: s.time, is_booked: s.is_booked })))}`);
}

// Обработчик для "Мои записи" (для специалистов)
async function handleMyClients(chatId, telegramId) {
  const user = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId]);
  const specialistRes = await db.query('SELECT id FROM specialists WHERE user_id = $1', [user.rows[0].id]);
  if (!specialistRes.rows.length) return bot.sendMessage(chatId, 'Вы не зарегистрированы как специалист.');

  const specialistId = specialistRes.rows[0].id;
  const bookingsRes = await db.query(`
    SELECT b.id, u.name AS client_name, s.date, s.time
    FROM bookings b
    JOIN slots s ON b.slot_id = s.id
    JOIN users u ON b.user_id = u.id
    WHERE s.specialist_id = $1
    ORDER BY s.date, s.time
  `, [specialistId]);

  const bookings = bookingsRes.rows;
  if (!bookings.length) return bot.sendMessage(chatId, 'К вам пока никто не записался.');

  for (const b of bookings) {
    await bot.sendMessage(chatId, `👤 ${b.client_name}\n📅 ${formatDateTime(b.date, b.time)}`);
  }
  logAction(`Специалист ${telegramId} просмотрел свои записи.`);
}

// Обработчик для "Записаться"
async function handleBook(chatId) {
  const specialists = await getAllSpecialists();
  if (!specialists.length) return bot.sendMessage(chatId, 'Нет доступных специалистов.');

  const buttons = specialists.map(s => [{
    text: `${s.name} — ${s.specialization}`,
    callback_data: `select_specialist_${s.id}`
  }]);

  return bot.sendMessage(chatId, 'Выберите специалиста:', {
    reply_markup: { inline_keyboard: buttons }
  });
}

// Обработчик выбора специалиста
async function handleSelectSpecialist(chatId, data) {
  const parts = data.split('_');
  if (parts.length !== 3 || parts[0] !== 'select' || parts[1] !== 'specialist') {
    logAction(`Некорректный формат data в handleSelectSpecialist: ${data}`);
    await bot.sendMessage(chatId, '❌ Ошибка: некорректный запрос. Попробуйте снова.');
    return;
  }

  const specialistId = parseInt(parts[2], 10);
  if (isNaN(specialistId)) {
    logAction(`Некорректный specialistId в handleSelectSpecialist: ${parts[2]}`);
    await bot.sendMessage(chatId, '❌ Ошибка: некорректный ID специалиста. Попробуйте снова.');
    return;
  }

  try {
    const servicesRes = await db.query('SELECT * FROM services WHERE specialist_id = $1', [specialistId]);
    const services = servicesRes.rows;
    if (!services.length) {
      await bot.sendMessage(chatId, 'У этого специалиста пока нет услуг.');
      logAction(`Нет услуг для специалиста #${specialistId}.`);
      return;
    }

    const keyboard = {
      inline_keyboard: services.map(s => [{ text: s.name, callback_data: `select_service_${specialistId}_${s.id}` }])
    };

    logAction(`Сформированы кнопки услуг для специалиста #${specialistId}: ${JSON.stringify(keyboard.inline_keyboard)}`);
    await bot.sendMessage(chatId, 'Выберите услугу:', { reply_markup: keyboard });
  } catch (err) {
    await bot.sendMessage(chatId, '❌ Ошибка при загрузке услуг. Попробуйте снова.');
    logAction(`Ошибка в handleSelectSpecialist для специалиста #${specialistId}: ${err.message}`);
    await notifyAdmins(`🚨 Ошибка в handleSelectSpecialist: ${err.message}`);
  }
}

// Обработчик выбора услуги
async function handleSelectService(chatId, data, messageId = null) {
  const parts = data.split('_');
  let specialistId, serviceId, page = 0;

  if (parts[0] === 'select' && parts[1] === 'service') {
    if (parts.length !== 4) {
      logAction(`Некорректный формат data в handleSelectService: ${data}`);
      await bot.sendMessage(chatId, '❌ Ошибка: некорректный запрос. Попробуйте снова.');
      return;
    }
    specialistId = parseInt(parts[2], 10);
    serviceId = parseInt(parts[3], 10);
  } else if (parts[0] === 'page') {
    if (parts.length !== 4) {
      logAction(`Некорректный формат data для пагинации в handleSelectService: ${data}`);
      await bot.sendMessage(chatId, '❌ Ошибка: некорректный запрос. Попробуйте снова.');
      return;
    }
    page = parseInt(parts[1], 10);
    specialistId = parseInt(parts[2], 10);
    serviceId = parseInt(parts[3], 10);
  } else {
    logAction(`Некорректный формат data в handleSelectService: ${data}`);
    await bot.sendMessage(chatId, '❌ Ошибка: некорректный запрос. Попробуйте снова.');
    return;
  }

  if (isNaN(specialistId) || isNaN(serviceId)) {
    logAction(`Некорректные значения в handleSelectService: specialistId=${parts[2]}, serviceId=${parts[3]}`);
    await bot.sendMessage(chatId, '❌ Ошибка: некорректные ID специалиста или услуги. Попробуйте снова.');
    return;
  }

  try {
    const slotsRes = await db.query(`
      SELECT s.id, s.date, s.time
      FROM slots s
      WHERE s.specialist_id = $1 AND s.is_booked = FALSE
      ORDER BY s.date, s.time
    `, [specialistId]);

    const slots = slotsRes.rows;
    if (!slots.length) {
      await bot.sendMessage(chatId, 'Нет доступных слотов для записи.');
      logAction(`Нет доступных слотов для специалиста #${specialistId}.`);
      return;
    }

    logAction(`Слоты до фильтрации для специалиста #${specialistId}: ${JSON.stringify(slots)}`);

    const now = new Date();
    const currentDate = now.toISOString().split('T')[0];
    const [currentHours, currentMinutes] = now.toTimeString().split(' ')[0].split(':');
    const currentTime = `${currentHours}:${currentMinutes}`;

    const filteredSlots = slots.filter(slot => {
      const slotFormattedDate = slot.date;
      const slotFormattedTime = slot.time.slice(0, 5);
      return (
        slotFormattedDate > currentDate ||
        (slotFormattedDate === currentDate && slotFormattedTime >= currentTime)
      );
    });

    if (!filteredSlots.length) {
      await bot.sendMessage(chatId, 'Нет доступных слотов на будущее.');
      logAction(`Нет доступных слотов на будущее для специалиста #${specialistId}.`);
      return;
    }

    logAction(`Отфильтрованные слоты для специалиста #${specialistId}: ${JSON.stringify(filteredSlots)}`);

    const slotsPerPage = 10;
    const totalPages = Math.ceil(filteredSlots.length / slotsPerPage);
    page = Math.max(0, Math.min(page, totalPages - 1));

    const startIndex = page * slotsPerPage;
    const endIndex = Math.min(startIndex + slotsPerPage, filteredSlots.length);
    const currentSlots = filteredSlots.slice(startIndex, endIndex);

    const keyboard = {
      inline_keyboard: [
        ...currentSlots.map(slot => [
          {
            text: `${formatDateTime(slot.date, slot.time)}`,
            callback_data: `select_slot_${specialistId}_${serviceId}_${slot.id}`
          }
        ]),
        totalPages > 1 ? [
          ...(page > 0 ? [{ text: '⬅️ Назад', callback_data: `page_${page - 1}_${specialistId}_${serviceId}` }] : []),
          ...(page < totalPages - 1 ? [{ text: '➡️ Далее', callback_data: `page_${page + 1}_${specialistId}_${serviceId}` }] : [])
        ] : []
      ]
    };

    logAction(`Сформированные кнопки для выбора слотов (страница ${page + 1}/${totalPages}): ${JSON.stringify(keyboard.inline_keyboard)}`);

    const messageText = `Выберите слот (страница ${page + 1} из ${totalPages}):`;
    if (messageId) {
      await bot.editMessageText(messageText, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard
      });
    } else {
      const message = await bot.sendMessage(chatId, messageText, { reply_markup: keyboard });
      messageId = message.message_id;
    }

    paginationTemp[chatId] = { specialistId, serviceId, page, messageId };
  } catch (err) {
    await bot.sendMessage(chatId, '❌ Ошибка при загрузке слотов. Попробуйте снова.');
    logAction(`Ошибка в handleSelectService для специалиста #${specialistId}: ${err.message}`);
    await notifyAdmins(`🚨 Ошибка в handleSelectService: ${err.message}`);
  }
}

// Обработчик создания записи
async function handleSelectSlot(chatId, telegramId, data) {
  const parts = data.split('_');
  if (parts.length !== 5 || parts[0] !== 'select' || parts[1] !== 'slot') {
    logAction(`Некорректный формат data в handleSelectSlot: ${data}`);
    await bot.sendMessage(chatId, '❌ Ошибка: некорректный запрос. Попробуйте снова.', {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Вернуться в меню', callback_data: 'book' }]]
      }
    });
    return;
  }

  const specialistId = parseInt(parts[2], 10);
  const serviceId = parseInt(parts[3], 10);
  const slotId = parseInt(parts[4], 10);

  if (isNaN(specialistId) || isNaN(serviceId) || isNaN(slotId)) {
    logAction(`Некорректные значения в handleSelectSlot: specialistId=${parts[2]}, serviceId=${parts[3]}, slotId=${parts[4]}`);
    await bot.sendMessage(chatId, '❌ Ошибка: некорректные ID. Попробуйте снова.', {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Вернуться в меню', callback_data: 'book' }]]
      }
    });
    return;
  }

  try {
    await db.query('BEGIN');

    const slotRes = await db.query(
      'SELECT date, time, is_booked FROM slots WHERE id = $1 FOR UPDATE',
      [slotId]
    );

    if (!slotRes.rows.length) {
      await db.query('ROLLBACK');
      await bot.sendMessage(chatId, 'Слот не найден.', {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Вернуться в меню', callback_data: 'book' }]]
        }
      });
      logAction(`Слот #${slotId} не найден при попытке записи пользователя ${telegramId}.`);
      return;
    }

    const slot = slotRes.rows[0];
    const isBooked = slot.is_booked === 't' || slot.is_booked === true;

    if (isBooked) {
      await db.query('ROLLBACK');
      await bot.sendMessage(chatId, 'Этот слот уже занят. Пожалуйста, выберите другой.', {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Вернуться в меню', callback_data: 'book' }]]
        }
      });
      logAction(`Слот #${slotId} уже занят при попытке записи пользователя ${telegramId}.`);
      return;
    }

    const user = await db.query('SELECT id, name FROM users WHERE telegram_id = $1', [telegramId]);
    if (!user.rows.length) {
      await db.query('ROLLBACK');
      await bot.sendMessage(chatId, 'Пользователь не найден.');
      return;
    }

    const specialist = await db.query(
      'SELECT s.user_id, u.name AS specialist_name ' +
      'FROM specialists s ' +
      'JOIN users u ON s.user_id = u.id ' +
      'WHERE s.id = $1',
      [specialistId]
    );
    if (!specialist.rows.length) {
      await db.query('ROLLBACK');
      await bot.sendMessage(chatId, 'Специалист не найден.');
      return;
    }

    const clientName = user.rows[0].name || 'Аноним';
    const specialistName = specialist.rows[0].specialist_name || 'Специалист';

    await db.query('INSERT INTO bookings (user_id, slot_id) VALUES ($1, $2)', [user.rows[0].id, slotId]);
    await db.query('UPDATE slots SET is_booked = TRUE WHERE id = $1', [slotId]);
    await db.query('COMMIT');

    const formattedDateTime = formatDateTime(slot.date, slot.time);
    await bot.sendMessage(chatId, `Вы записаны! 📅 ${formattedDateTime} к ${specialistName}`, {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Вернуться в меню', callback_data: 'book' }]]
      }
    });
    logAction(`Клиент ${telegramId} (${clientName}) записался на слот #${slotId} к специалисту #${specialistId} (${specialistName}).`);

    const specialistUser = await db.query('SELECT telegram_id FROM users WHERE id = $1', [specialist.rows[0].user_id]);
    if (specialistUser.rows.length) {
      await bot.sendMessage(specialistUser.rows[0].telegram_id, `Новая запись: 📅 ${formattedDateTime} от ${clientName}`);
    }
    await notifyAdmins(`Новая запись: Клиент ${clientName} записался к специалисту ${specialistName} (#${specialistId}) на ${formattedDateTime}.`);
  } catch (err) {
    await db.query('ROLLBACK');
    await bot.sendMessage(chatId, '❌ Ошибка при записи. Попробуйте снова.', {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Вернуться в меню', callback_data: 'book' }]]
      }
    });
    logAction(`Ошибка при записи пользователя ${telegramId} на слот #${slotId}: ${err.message}`);
    await notifyAdmins(`🚨 Ошибка при записи на слот #${slotId}: ${err.message}`);
  }
}

// Обработчик обратной связи
async function handleFeedback(chatId, userId) {
  bot.sendMessage(chatId, '✉️ Введите сообщение для администратора:');
  bot.once('message', async (msg) => {
    const feedbackText = msg.text;
    await db.query(
      'INSERT INTO feedback_requests (user_id, message, status) VALUES ($1, $2, $3)',
      [userId, feedbackText, 'новая']
    );
    bot.sendMessage(chatId, '✅ Ваше сообщение отправлено. Администратор свяжется с вами.');
    logAction(`Пользователь ${userId} отправил обратную связь: ${feedbackText}`);
  });
}

// Обработчик админ-панели
async function handleAdminPanel(chatId, role) {
  if (role !== 'admin') return bot.sendMessage(chatId, '⛔ Доступ запрещён.');

  const buttons = [
    [{ text: '➕ Добавить специалиста', callback_data: 'admin_add_specialist' }],
    [{ text: '➕ Добавить услугу', callback_data: 'admin_add_service' }],
    [{ text: '➕ Добавить слот', callback_data: 'admin_add_slot' }],
    [{ text: '✏️ Редактировать услуги', callback_data: 'admin_edit_services' }],
    [{ text: '📊 Статистика', callback_data: 'admin_stats' }]
  ];

  const feedbacks = await getActiveFeedbackRequests();
  for (const f of feedbacks) {
    await bot.sendMessage(chatId, `#${f.id} — ${f.message} [${f.status}]`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Ответить', callback_data: `admin_reply_${f.id}` }],
          [{ text: 'Закрыть', callback_data: `admin_close_${f.id}` }]
        ]
      }
    });
  }

  return bot.sendMessage(chatId, '⚙️ Админ-панель:', {
    reply_markup: { inline_keyboard: buttons }
  });
}

// Обработчик добавления специалиста
async function handleAdminAddSpecialist(chatId) {
  adminTemp[chatId] = {};
  bot.sendMessage(chatId, 'Введите telegram_id специалиста:');
  bot.once('message', async (msg) => {
    const telegramId = parseInt(msg.text);
    if (isNaN(telegramId)) {
      return bot.sendMessage(chatId, '❌ Неверный telegram_id. Попробуйте снова.');
    }
    const userCheck = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId]);
    if (userCheck.rows.length > 0) {
      return bot.sendMessage(chatId, '❌ Этот telegram_id уже зарегистрирован.');
    }
    adminTemp[chatId].telegramId = telegramId;

    bot.sendMessage(chatId, 'Введите имя специалиста:');
    bot.once('message', (msg) => {
      adminTemp[chatId].name = msg.text;
      bot.sendMessage(chatId, 'Введите специализацию:');
      bot.once('message', (msg2) => {
        adminTemp[chatId].specialization = msg2.text;
        bot.sendMessage(chatId, 'Введите описание специалиста:');
        bot.once('message', async (msg3) => {
          try {
            const userRes = await db.query('INSERT INTO users (telegram_id, name, role) VALUES ($1, $2, $3) RETURNING id',
              [adminTemp[chatId].telegramId, adminTemp[chatId].name, 'specialist']);
            const userId = userRes.rows[0].id;

            const spec = await insertSpecialist(userId, adminTemp[chatId].specialization, msg3.text);
            adminTemp[chatId].specialistId = spec.id;

            bot.sendMessage(chatId, '✅ Специалист добавлен. Введите первую услугу:');
            bot.once('message', async (msg4) => {
              try {
                await addService(spec.id, msg4.text);
                bot.sendMessage(chatId, 'Теперь введите слот (формат: ГГГГ-ММ-ДД ЧЧ:ММ):');
                bot.once('message', async (msg5) => {
                  try {
                    const [date, time] = msg5.text.split(' ');
                    validateDateTime(date, time);
                    await addSlot(spec.id, date, time);
                    bot.sendMessage(chatId, '✅ Слот добавлен.');
                    logAction(`Админ ${chatId} добавил специалиста #${spec.id} и слот на ${date} ${time}.`);
                  } catch (err) {
                    bot.sendMessage(chatId, `❌ ${err.message}`);
                    logAction(`Ошибка при добавлении слота админом ${chatId}: ${err.message}`);
                  }
                });
              } catch (err) {
                bot.sendMessage(chatId, '❌ Ошибка при добавлении услуги.');
                logAction(`Ошибка при добавлении услуги админом ${chatId}: ${err.message}`);
              }
            });
          } catch (err) {
            console.error('Ошибка при добавлении специалиста:', err);
            bot.sendMessage(chatId, '❌ Ошибка при добавлении специалиста.');
            logAction(`Ошибка при добавлении специалиста админом ${chatId}: ${err.message}`);
          }
        });
      });
    });
  });
}

// Обработчик добавления услуги
async function handleAdminAddService(chatId) {
  const specs = await getAllSpecialists();
  const buttons = specs.map(s => [{
    text: `${s.name} — ${s.specialization}`,
    callback_data: `service_for_${s.id}`
  }]);

  return bot.sendMessage(chatId, 'Выберите специалиста:', {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handleServiceFor(chatId, data) {
  const specialistId = parseInt(data.split('_').pop(), 10);
  addServiceTemp[chatId] = specialistId;
  bot.sendMessage(chatId, 'Введите название услуги (только текст, без команд или дат):');
  bot.once('message', async (msg) => {
    const serviceName = msg.text.trim();
    // Валидация: проверяем, что название не является командой или датой
    const isValidName = /^[a-zA-Zа-яА-Я\s-]+$/.test(serviceName);
    if (!isValidName) {
      bot.sendMessage(chatId, '❌ Название услуги должно содержать только буквы, пробелы или дефисы. Попробуйте снова.');
      logAction(`Админ ${chatId} ввёл некорректное название услуги: ${serviceName}`);
      return;
    }
    try {
      await addService(specialistId, serviceName);
      bot.sendMessage(chatId, '✅ Услуга добавлена.');
      logAction(`Админ ${chatId} добавил услугу для специалиста #${specialistId}: ${serviceName}`);
    } catch (err) {
      bot.sendMessage(chatId, '❌ Ошибка при добавлении услуги.');
      logAction(`Ошибка при добавлении услуги админом ${chatId}: ${err.message}`);
    }
  });
}

// Обработчик добавления слота
async function handleAdminAddSlot(chatId) {
  const specs = await getAllSpecialists();
  const buttons = specs.map(s => [{
    text: `${s.name} — ${s.specialization}`,
    callback_data: `slot_for_${s.id}`
  }]);

  return bot.sendMessage(chatId, 'Выберите специалиста:', {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handleSlotFor(chatId, data) {
  const specialistId = parseInt(data.split('_').pop(), 10);
  addSlotTemp[chatId] = specialistId;
  bot.sendMessage(chatId, 'Введите слот (формат: ГГГГ-ММ-ДД ЧЧ:ММ):');
  bot.once('message', async (msg) => {
    try {
      const [date, time] = msg.text.split(' ');
      validateDateTime(date, time);
      await addSlot(specialistId, date, time);
      bot.sendMessage(chatId, '✅ Слот добавлен.');
      logAction(`Админ ${chatId} добавил слот для специалиста #${specialistId} на ${date} ${time}.`);
    } catch (err) {
      bot.sendMessage(chatId, `❌ ${err.message}`);
      logAction(`Ошибка при добавлении слота админом ${chatId}: ${err.message}`);
    }
  });
}

// Обработчик редактирования услуг
async function handleEditServices(chatId) {
  const specialists = await getAllSpecialists();
  if (!specialists.length) return bot.sendMessage(chatId, 'Нет специалистов.');

  const buttons = specialists.map(s => [{
    text: `${s.name} — ${s.specialization}`,
    callback_data: `edit_services_for_${s.id}`
  }]);

  return bot.sendMessage(chatId, 'Выберите специалиста для редактирования услуг:', {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handleEditServicesFor(chatId, data) {
  const specialistId = parseInt(data.split('_').pop(), 10);
  editServiceTemp[chatId] = { specialistId, currentServiceIndex: 0 };
  const services = await getServicesBySpecialist(specialistId);
  if (!services.length) return bot.sendMessage(chatId, 'У специалиста нет услуг.');

  const currentService = services[editServiceTemp[chatId].currentServiceIndex];
  bot.sendMessage(chatId, `Редактирование услуги ${editServiceTemp[chatId].currentServiceIndex + 1} из ${services.length}: "${currentService.name}". Введите новое название:`);
  bot.once('message', async (msg) => {
    try {
      await updateService(currentService.id, msg.text);
      editServiceTemp[chatId].currentServiceIndex++;
      if (editServiceTemp[chatId].currentServiceIndex < services.length) {
        const nextService = services[editServiceTemp[chatId].currentServiceIndex];
        bot.sendMessage(chatId, `Редактирование услуги ${editServiceTemp[chatId].currentServiceIndex + 1} из ${services.length}: "${nextService.name}". Введите новое название:`);
        bot.once('message', (msg2) => {
          handleEditServiceRecursively(chatId, services, msg2.text);
        });
      } else {
        bot.sendMessage(chatId, '✅ Все услуги отредактированы.');
        delete editServiceTemp[chatId];
        logAction(`Админ ${chatId} отредактировал услуги специалиста #${specialistId}.`);
      }
    } catch (err) {
      bot.sendMessage(chatId, '❌ Ошибка при обновлении услуги.');
      logAction(`Ошибка при редактировании услуги админом ${chatId}: ${err.message}`);
    }
  });
}

async function handleEditServiceRecursively(chatId, services, newName) {
  const currentService = services[editServiceTemp[chatId].currentServiceIndex];
  try {
    await updateService(currentService.id, newName);
    editServiceTemp[chatId].currentServiceIndex++;
    if (editServiceTemp[chatId].currentServiceIndex < services.length) {
      const nextService = services[editServiceTemp[chatId].currentServiceIndex];
      bot.sendMessage(chatId, `Редактирование услуги ${editServiceTemp[chatId].currentServiceIndex + 1} из ${services.length}: "${nextService.name}". Введите новое название:`);
      bot.once('message', (msg) => {
        handleEditServiceRecursively(chatId, services, msg.text);
      });
    } else {
      bot.sendMessage(chatId, '✅ Все услуги отредактированы.');
      delete editServiceTemp[chatId];
    }
  } catch (err) {
    bot.sendMessage(chatId, '❌ Ошибка при обновлении услуги.');
    logAction(`Ошибка при редактировании услуги админом ${chatId}: ${err.message}`);
  }
}

// Обработчик редактирования слота
async function handleEditSlot(chatId, data) {
  const slotId = parseInt(data.split('_').pop(), 10);
  editSlotTemp[chatId] = { slotId };
  bot.sendMessage(chatId, 'Введите новую дату и время (формат: ГГГГ-ММ-ДД ЧЧ:ММ):');
  bot.once('message', async (msg) => {
    try {
      const [date, time] = msg.text.split(' ');
      validateDateTime(date, time);
      await updateSlot(slotId, date, time);
      bot.sendMessage(chatId, '✅ Слот успешно отредактирован.');
      logAction(`Слот #${slotId} отредактирован на ${date} ${time}.`);
    } catch (err) {
      bot.sendMessage(chatId, `❌ ${err.message}`);
      logAction(`Ошибка при редактировании слота #${slotId}: ${err.message}`);
    }
  });
}

// Обработчик удаления слота
async function handleDeleteSlot(chatId, data) {
  const slotId = parseInt(data.split('_').pop(), 10);
  try {
    await deleteSlot(slotId);
    bot.sendMessage(chatId, '✅ Слот успешно удалён.');
    logAction(`Слот #${slotId} удалён.`);
  } catch (err) {
    bot.sendMessage(chatId, '❌ Ошибка при удалении слота.');
    logAction(`Ошибка при удалении слота #${slotId}: ${err.message}`);
  }
}

// Обработчик ответа на заявку
async function handleAdminReply(chatId, data) {
  const requestId = parseInt(data.split('_').pop(), 10);
  bot.sendMessage(chatId, 'Введите ответ пользователю:');
  bot.once('message', async (msg) => {
    const response = msg.text;
    await setAdminResponse(requestId, response);
    const feedbackUserId = await getFeedbackUser(requestId);
    if (feedbackUserId) {
      const feedbackUser = await db.query('SELECT telegram_id FROM users WHERE id = $1', [feedbackUserId]);
      if (feedbackUser.rows[0]?.telegram_id) {
        bot.sendMessage(feedbackUser.rows[0].telegram_id, `✉️ Ответ администратора: ${response}`);
      }
    }
    bot.sendMessage(chatId, '✅ Ответ отправлен.');
    logAction(`Админ ${chatId} ответил на заявку #${requestId}: ${response}`);
  });
}

// Обработчик закрытия заявки
async function handleAdminClose(chatId, data) {
  const requestId = parseInt(data.split('_').pop(), 10);
  await closeFeedbackRequest(requestId);
  bot.sendMessage(chatId, '✅ Заявка закрыта.');
  logAction(`Админ ${chatId} закрыл заявку #${requestId}.`);
}

// Обработчик отмены записи
async function handleCancelBooking(chatId, telegramId, data) {
  const bookingId = parseInt(data.split('_').pop(), 10);
  try {
    const user = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId]);
    const userId = user.rows[0].id;
    const booking = await db.query('SELECT slot_id FROM bookings WHERE id = $1 AND user_id = $2', [bookingId, userId]);
    if (!booking.rows.length) {
      return bot.sendMessage(chatId, '❌ У вас нет прав отменить эту запись.');
    }

    const slotId = booking.rows[0].slot_id;
    await db.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
    await db.query('UPDATE slots SET is_booked = FALSE WHERE id = $1', [slotId]);
    bot.sendMessage(chatId, '✅ Запись отменена.');
    logAction(`Пользователь ${telegramId} отменил запись #${bookingId}.`);
  } catch (err) {
    console.error('Ошибка при отмене записи:', err);
    bot.sendMessage(chatId, '❌ Ошибка при отмене записи.');
    logAction(`Ошибка при отмене записи #${bookingId} пользователем ${telegramId}: ${err.message}`);
  }
}

// Обработчик статистики
async function handleAdminStats(chatId) {
  const [
    specialists, clients, totalBookings,
    todayBookings, totalSlots, bookedSlots
  ] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM users WHERE role = 'specialist'`),
    db.query(`SELECT COUNT(*) FROM users WHERE role = 'client' OR role IS NULL`),
    db.query(`SELECT COUNT(*) FROM bookings`),
    db.query(`
      SELECT COUNT(*) 
      FROM bookings b 
      JOIN slots s ON b.slot_id = s.id 
      WHERE DATE(s.date) = CURRENT_DATE
    `),
    db.query(`SELECT COUNT(*) FROM slots`),
    db.query(`SELECT COUNT(*) FROM slots WHERE is_booked = TRUE`)
  ]);

  const statsText = `
📊 Статистика:

👨‍⚕️ Специалистов: ${specialists.rows[0].count}
👥 Клиентов: ${clients.rows[0].count}
📅 Записей всего: ${totalBookings.rows[0].count}
📆 За сегодня: ${todayBookings.rows[0].count}
🔒 Слотов занято: ${bookedSlots.rows[0].count}
🔓 Слотов свободно: ${totalSlots.rows[0].count - bookedSlots.rows[0].count}
`.trim();

  bot.sendMessage(chatId, statsText);
  logAction(`Админ ${chatId} запросил статистику.`);
}

// Основной обработчик callback_query
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const data = query.data;
  const messageId = query.message.message_id;

  logAction(`Получен callback_query от пользователя ${telegramId}: data=${data}`);

  try {
    const user = await db.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    if (!user.rows.length) {
      await bot.sendMessage(chatId, '❌ Пользователь не найден. Пожалуйста, используйте /start.');
      logAction(`Пользователь ${telegramId} не найден в базе данных.`);
      return;
    }

    const userId = user.rows[0].id;
    const role = user.rows[0].role || 'client';

    if (data === 'my_slots') return handleMySlots(chatId, telegramId, 0, messageId);
    if (data.startsWith('my_slots_page_')) {
      const page = parseInt(data.split('_')[3], 10);
      return handleMySlots(chatId, telegramId, page, messageId);
    }
    if (data === 'my_clients') return handleMyClients(chatId, telegramId);
    if (data === 'book') return handleBook(chatId);
    if (data.startsWith('select_specialist_')) return handleSelectSpecialist(chatId, data);
    if (data.startsWith('select_service_') || data.startsWith('page_')) return handleSelectService(chatId, data, messageId);
    if (data.startsWith('select_slot_')) return handleSelectSlot(chatId, telegramId, data);
    if (data === 'feedback') return handleFeedback(chatId, userId);
    if (data === 'admin_panel') return handleAdminPanel(chatId, role);
    if (data === 'admin_add_specialist') return handleAdminAddSpecialist(chatId);
    if (data === 'admin_add_service') return handleAdminAddService(chatId);
    if (data.startsWith('service_for_')) return handleServiceFor(chatId, data);
    if (data === 'admin_add_slot') return handleAdminAddSlot(chatId);
    if (data.startsWith('slot_for_')) return handleSlotFor(chatId, data);
    if (data.startsWith('admin_reply_')) return handleAdminReply(chatId, data);
    if (data.startsWith('admin_close_')) return handleAdminClose(chatId, data);
    if (data.startsWith('cancel_booking_')) return handleCancelBooking(chatId, telegramId, data);
    if (data.startsWith('edit_slot_')) return handleEditSlot(chatId, data);
    if (data.startsWith('delete_slot_')) return handleDeleteSlot(chatId, data);
    if (data === 'admin_edit_services') return handleEditServices(chatId);
    if (data.startsWith('edit_services_for_')) return handleEditServicesFor(chatId, data);
    if (data === 'my_bookings_view') return handleMyBookingsView(chatId, telegramId);
    if (data === 'admin_stats') return handleAdminStats(chatId);

    logAction(`Неизвестный callback_data от пользователя ${telegramId}: ${data}`);
    await bot.sendMessage(chatId, '❌ Неизвестная команда. Попробуйте снова с /start.');
  } catch (err) {
    logAction(`Ошибка в обработчике callback_query для data=${data}: ${err.message}`);
    await bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте снова с /start.');
    await notifyAdmins(`🚨 Ошибка в callback_query для data=${data}: ${err.message}`);
  }
});

// Регистрация команд
bot.onText(/\/slots/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  const user = await db.query('SELECT role FROM users WHERE telegram_id = $1', [telegramId]);
  if (user.rows[0]?.role !== 'admin') {
    return bot.sendMessage(chatId, '⛔ У вас нет прав для этой команды.');
  }

  try {
    const specialists = await getAllSpecialists();
    for (const specialist of specialists) {
      const slots = await db.query(
        'SELECT id, date, time, is_booked FROM slots WHERE specialist_id = $1 ORDER BY date, time',
        [specialist.id]
      );
      let message = `Онлайн запись к специалисту ${specialist.name}, [${new Date().toLocaleString('ru-RU')}]`;
      for (const slot of slots.rows) {
        const isBooked = slot.is_booked === 't' || slot.is_booked === true;
        const status = isBooked ? 'Занят' : 'Свободен';
        message += `\n📅 ${formatDateTime(slot.date, slot.time)} — ${status}`;
      }
      await bot.sendMessage(chatId, message);
    }
    logAction(`Админ ${telegramId} запросил слоты.`);
  } catch (err) {
    console.error('Ошибка при отображении слотов:', err);
    bot.sendMessage(chatId, '❌ Ошибка при отображении слотов.');
    logAction(`Ошибка /slots для админа ${telegramId}: ${err.message}`);
  }
});
bot.onText(/\/start/, handleStart);
bot.onText(/\/admin/, handleAdmin);
bot.onText(/\/mybookings/, handleMyBookings);