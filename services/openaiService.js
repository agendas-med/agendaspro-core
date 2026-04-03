const { OpenAI } = require("openai");
const functions = require("../utils/functions");
const _appointmentsService = require("./appointmentsService");
const _asaasService = require("./asaasService");
const moment = require("moment");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let openaiService = {
  processWhatsAppMessage: async function (phone, userMessage) {
    let session = await this.getOrCreateSession(phone);
    const msgClean = userMessage.trim();
    let collectedData = session.collected_data;

    switch (session.stage) {
      case "menu":
        if (msgClean === "1") {
          await this.updateSessionStage(
            session.id,
            "ask_service_details",
            collectedData,
          );
          return {
            reply:
              "Maravilha! Qual serviço você está buscando hoje e em qual cidade? 💇‍♀️✨\n\n(Ex: Corte de cabelo em Curitiba)",
          };
        } else if (msgClean === "2") {
          await this.updateSessionStage(
            session.id,
            "reschedule_collect",
            collectedData,
          );
          return {
            reply:
              "Com certeza! Para localizar seu agendamento, por favor me informe o seu *CPF* (apenas números).",
          };
        } else {
          return {
            reply:
              "Olá! Sou o assistente do AgendasPRO. 🗓️\n\nEscolha uma opção:\n*1* - Novo Agendamento\n*2* - Reagendar Serviço",
          };
        }

      // FLUXO DE NOVO AGENDAMENTO
      case "ask_service_details":
        const serviceInfo = await this.extractData(msgClean, "service_search");

        const searchQueries =
          serviceInfo.queries && serviceInfo.queries.length > 0
            ? serviceInfo.queries
            : collectedData.last_queries;

        const searchCity = serviceInfo.city
          ? serviceInfo.city
          : collectedData.last_city || "";

        if (!searchQueries || searchQueries.length === 0) {
          return {
            reply:
              "Não consegui entender qual serviço você deseja. Pode repetir de forma mais simples?",
          };
        }

        collectedData.last_queries = searchQueries;
        collectedData.last_city = searchCity;

        const availableServices = await this.findServicesInDB(
          searchQueries,
          searchCity,
        );

        if (availableServices.length === 0) {
          await this.updateSessionStage(
            session.id,
            "ask_service_details",
            collectedData,
          );
          return {
            reply: `Não encontrei vagas para "${searchQueries.join(" ")}"${searchCity ? ` em ${searchCity}` : ""}. Tente buscar por outro serviço ou local.`,
          };
        }

        if (availableServices.length === 1) {
          collectedData.selected_service = availableServices[0];
          await this.updateSessionStage(session.id, "ask_date", collectedData);
          return {
            reply: `Encontrei o serviço *${availableServices[0].name}* em *${availableServices[0].company_name}* (${availableServices[0].city}).\n\nPara qual data você deseja? (Ex: amanhã, 20/05)`,
          };
        }

        collectedData.temp_services = availableServices;
        await this.updateSessionStage(
          session.id,
          "select_service",
          collectedData,
        );

        let listMsg =
          "Encontrei estas opções. Qual você prefere? Responda com o número:\n\n";
        availableServices.forEach((srv, idx) => {
          listMsg += `*${idx + 1}* - ${srv.name} | ${srv.company_name} (${srv.city}) - R$ ${srv.value}\n`;
        });
        return { reply: listMsg };

      case "select_service":
        const srvIdx = parseInt(msgClean) - 1;
        if (isNaN(srvIdx) || !collectedData.temp_services[srvIdx]) {
          return {
            reply: "Por favor, escolha um número válido da lista acima.",
          };
        }

        collectedData.selected_service = collectedData.temp_services[srvIdx];
        delete collectedData.temp_services;
        await this.updateSessionStage(session.id, "ask_date", collectedData);
        return { reply: "Ótimo! Para qual data você deseja agendar? 📅" };

      case "ask_date":
        const dateInfo = await this.extractData(msgClean, "date");
        let targetDate = dateInfo.date;

        if (!targetDate && dateInfo.time) {
          targetDate = moment().format("YYYY-MM-DD");
        }

        if (!targetDate) {
          return {
            reply:
              "Não entendi a data. Pode me dizer de outra forma? (Ex: dia 15/08, amanhã às 14h)",
          };
        }

        collectedData.date = targetDate;
        const availability = await this.calculateFreeSlots(
          collectedData.selected_service.company_id,
          collectedData.date,
          collectedData.selected_service.duration,
        );

        if (availability.slots.length === 0) {
          return {
            reply: `Poxa, não há horários livres para o dia ${moment(collectedData.date).format("DD/MM/YYYY")}. Pode me informar outra data?`,
          };
        }

        if (dateInfo.time && availability.slots.includes(dateInfo.time)) {
          collectedData.time = dateInfo.time;
          await this.updateSessionStage(
            session.id,
            "ask_customer_data",
            collectedData,
          );

          const targetDateTime = moment(
            `${collectedData.date} ${collectedData.time}`,
            "YYYY-MM-DD HH:mm",
          );
          const diffFromNow = targetDateTime.diff(moment(), "hours");

          if (diffFromNow < 12) {
            return {
              reply: `Excelente! O horário das ${collectedData.time} está disponível.\n\n⚠️ *Aviso Importante*: Como o horário é para daqui a menos de 12 horas, não será possível reagendá-lo posteriormente.\n\nPara confirmar que concorda e finalizar, por favor, me informe na mesma mensagem o seu *Nome Completo*, *Data de Nascimento* e *CPF*.`,
            };
          } else {
            return {
              reply: `Excelente! O horário das ${collectedData.time} está disponível e já reservei para você.\n\nPara eu finalizar no sistema, por favor, me informe na mesma mensagem o seu *Nome Completo*, *Data de Nascimento* e *CPF*.`,
            };
          }
        }

        collectedData.temp_slots = availability.slots;
        await this.updateSessionStage(session.id, "select_time", collectedData);

        let dateReplyMsg = `Para o dia ${moment(collectedData.date).format("DD/MM/YYYY")}, temos estes horários:\n\n${availability.slots.join(" | ")}\n\nQual fica melhor para você?`;
        if (dateInfo.time) {
          dateReplyMsg = `O horário das ${dateInfo.time} não está disponível, mas temos estas opções livres para o dia ${moment(collectedData.date).format("DD/MM/YYYY")}:\n\n${availability.slots.join(" | ")}\n\nQual fica melhor para você?`;
        }
        return { reply: dateReplyMsg };

      case "select_time":
        const timeInfo = await this.extractData(msgClean, "time");

        if (
          !timeInfo.time ||
          !collectedData.temp_slots.includes(timeInfo.time)
        ) {
          return {
            reply: `Por favor, escolha um dos horários exatos da lista: ${collectedData.temp_slots.join(", ")}`,
          };
        }

        collectedData.time = timeInfo.time;
        delete collectedData.temp_slots;
        await this.updateSessionStage(
          session.id,
          "ask_customer_data",
          collectedData,
        );

        const targetDateTimeSelect = moment(
          `${collectedData.date} ${collectedData.time}`,
          "YYYY-MM-DD HH:mm",
        );
        const diffFromNowSelect = targetDateTimeSelect.diff(moment(), "hours");

        if (diffFromNowSelect < 12) {
          return {
            reply: `Horário das ${collectedData.time} reservado!\n\n⚠️ *Aviso Importante*: Como o horário é para daqui a menos de 12 horas, não será possível reagendá-lo posteriormente.\n\nPara confirmar e finalizar no sistema, por favor, me informe na mesma mensagem o seu *Nome Completo*, *Data de Nascimento* e *CPF*.`,
          };
        } else {
          return {
            reply: `Horário das ${collectedData.time} reservado! Para finalizar o agendamento no sistema, por favor, me informe na mesma mensagem o seu *Nome Completo*, *Data de Nascimento* e *CPF*.`,
          };
        }

      case "ask_customer_data":
        const customerInfo = await this.extractData(msgClean, "customer_data");

        if (!customerInfo.name || !customerInfo.cpf || !customerInfo.birthday) {
          return {
            reply:
              "Preciso do seu Nome Completo, Data de Nascimento e CPF para registrar no sistema. Pode me enviar?",
          };
        }

        const srv = collectedData.selected_service;
        const bookingResult = await this.processBooking(phone, {
          company_id: srv.company_id,
          customer_name: customerInfo.name,
          customer_birthday: customerInfo.birthday,
          customer_cpf: customerInfo.cpf,
          date: `${collectedData.date} ${collectedData.time}:00`,
          duration: srv.duration,
          total_value: srv.value,
          services: [
            {
              id: srv.id,
              name: srv.name,
              value: srv.value,
              duration: srv.duration,
            },
          ],
        });

        await this.closeSession(session.id);

        if (bookingResult.includes("PAGAMENTO_PENDENTE")) {
          const url = bookingResult.split("|")[1];
          return {
            reply: `Tudo certo, ${customerInfo.name}! 🎉\n\nSeu agendamento exige pagamento antecipado. Acesse o link abaixo para concluir:\n${url}\n\nLembre-se de chegar com 15 minutos de antecedência no local.`,
          };
        } else if (bookingResult.includes("SUCESSO")) {
          return {
            reply: `Tudo certo, ${customerInfo.name}! 🎉 Seu agendamento para o dia ${moment(collectedData.date).format("DD/MM")} às ${collectedData.time} foi confirmado.\n\nPor favor, compareça com 15 minutos de antecedência.`,
          };
        } else {
          return { reply: bookingResult };
        }

      // FLUXO DE REAGENDAMENTO
      case "reschedule_collect":
        const extractedCpf = msgClean.replace(/\D/g, "");

        if (extractedCpf.length < 11) {
          return {
            reply:
              "Por favor, digite um CPF válido com 11 dígitos para que eu possa localizar sua reserva.",
          };
        }

        const appointments = await this.getCustomerAppointments(
          phone,
          extractedCpf,
        );

        if (typeof appointments === "string" || appointments.length === 0) {
          await this.updateSessionStage(session.id, "menu", {});
          return {
            reply:
              "Não encontrei nenhum agendamento ativo para este CPF ou telefone. 😕\n\nO que deseja fazer?\n*1* - Novo Agendamento\n*2* - Tentar Reagendar com outro CPF",
          };
        }

        if (appointments.length > 1) {
          collectedData.temp_list = appointments;
          await this.updateSessionStage(
            session.id,
            "reschedule_select",
            collectedData,
          );
          let appListMsg =
            "Localizei seus agendamentos! Qual você deseja alterar? Responda com o número:\n\n";
          appointments.forEach((app, idx) => {
            appListMsg += `*${idx + 1}* - ${app.company_name} (${moment(app.date).format("DD/MM [às] HH:mm")})\n`;
          });
          return { reply: appListMsg };
        } else {
          collectedData.selected_appointment = appointments[0];
          return await this.validateAndProceedReschedule(
            session,
            collectedData,
          );
        }

      case "reschedule_select":
        const appIdx = parseInt(msgClean) - 1;
        const selectedApp =
          collectedData.temp_list && collectedData.temp_list[appIdx];

        if (!selectedApp) {
          return { reply: "Por favor, escolha uma opção válida da lista." };
        }

        collectedData.selected_appointment = selectedApp;
        delete collectedData.temp_list;
        return await this.validateAndProceedReschedule(session, collectedData);

      case "ask_new_date":
        const newDateInfo = await this.extractData(msgClean, "date");
        let targetNewDate = newDateInfo.date;

        if (!targetNewDate && newDateInfo.time) {
          targetNewDate = moment(
            collectedData.selected_appointment.date,
          ).format("YYYY-MM-DD");
        }

        if (!targetNewDate) {
          return {
            reply:
              "Não entendi a data. Pode me informar no formato dia/mês ou dizer amanhã/sexta?",
          };
        }

        collectedData.new_date = targetNewDate;
        const newAvailability = await this.calculateFreeSlots(
          collectedData.selected_appointment.company_id,
          collectedData.new_date,
          collectedData.selected_appointment.duration,
        );

        if (newAvailability.slots.length === 0) {
          return {
            reply: `Não temos vagas disponíveis na data ${moment(collectedData.new_date).format("DD/MM/YYYY")}. Qual outra data você prefere?`,
          };
        }

        if (
          newDateInfo.time &&
          newAvailability.slots.includes(newDateInfo.time)
        ) {
          const targetNewDateTime = moment(
            `${collectedData.new_date} ${newDateInfo.time}`,
            "YYYY-MM-DD HH:mm",
          );
          const diffNewFromNow = targetNewDateTime.diff(moment(), "hours");

          if (diffNewFromNow < 12) {
            collectedData.time = newDateInfo.time;
            await this.updateSessionStage(
              session.id,
              "confirm_short_notice_reschedule",
              collectedData,
            );
            return {
              reply: `⚠️ *Aviso Importante*: O horário das ${newDateInfo.time} está livre, mas como é daqui a menos de 12 horas, você não poderá alterá-lo novamente depois se precisar.\n\nDeseja confirmar o reagendamento para este horário? (Responda *Sim* ou *Não*)`,
            };
          } else {
            const quickRescheduleResult = await this.processReschedule({
              appointment_id: collectedData.selected_appointment.appointment_id,
              new_date: `${collectedData.new_date} ${newDateInfo.time}:00`,
              duration: collectedData.selected_appointment.duration,
              company_id: collectedData.selected_appointment.company_id,
            });
            await this.closeSession(session.id);
            return {
              reply: `${quickRescheduleResult}\n\nPor favor, chegue com 15 minutos de antecedência no local.`,
            };
          }
        }

        collectedData.temp_slots = newAvailability.slots;
        await this.updateSessionStage(
          session.id,
          "select_new_time",
          collectedData,
        );

        let newDateReplyMsg = `Para o dia ${moment(collectedData.new_date).format("DD/MM/YYYY")}, temos:\n\n${newAvailability.slots.join(" | ")}\n\nQual horário fica melhor?`;
        if (newDateInfo.time) {
          newDateReplyMsg = `Infelizmente as ${newDateInfo.time} não está mais vago. Temos estas opções para o dia ${moment(collectedData.new_date).format("DD/MM/YYYY")}:\n\n${newAvailability.slots.join(" | ")}\n\nQual você prefere?`;
        }
        return { reply: newDateReplyMsg };

      case "select_new_time":
        const newTimeInfo = await this.extractData(msgClean, "time");

        if (
          !newTimeInfo.time ||
          !collectedData.temp_slots.includes(newTimeInfo.time)
        ) {
          return {
            reply: `Escolha um dos horários válidos: ${collectedData.temp_slots.join(", ")}`,
          };
        }

        const targetNewDateTimeSelect = moment(
          `${collectedData.new_date} ${newTimeInfo.time}`,
          "YYYY-MM-DD HH:mm",
        );
        const diffNewFromNowSelect = targetNewDateTimeSelect.diff(
          moment(),
          "hours",
        );

        if (diffNewFromNowSelect < 12) {
          collectedData.time = newTimeInfo.time;
          await this.updateSessionStage(
            session.id,
            "confirm_short_notice_reschedule",
            collectedData,
          );
          return {
            reply: `⚠️ *Aviso Importante*: Como o horário escolhido (${newTimeInfo.time}) é daqui a menos de 12 horas, você não poderá alterá-lo novamente depois se precisar.\n\nDeseja confirmar o reagendamento para este horário? (Responda *Sim* ou *Não*)`,
          };
        } else {
          const rescheduleResult = await this.processReschedule({
            appointment_id: collectedData.selected_appointment.appointment_id,
            new_date: `${collectedData.new_date} ${newTimeInfo.time}:00`,
            duration: collectedData.selected_appointment.duration,
            company_id: collectedData.selected_appointment.company_id,
          });
          await this.closeSession(session.id);
          return {
            reply: `${rescheduleResult}\n\nPor favor, chegue com 15 minutos de antecedência no local.`,
          };
        }

      case "confirm_short_notice_reschedule":
        const confirmation = msgClean.toLowerCase();
        if (confirmation === "sim" || confirmation === "s") {
          const rescheduleResult = await this.processReschedule({
            appointment_id: collectedData.selected_appointment.appointment_id,
            new_date: `${collectedData.new_date} ${collectedData.time}:00`,
            duration: collectedData.selected_appointment.duration,
            company_id: collectedData.selected_appointment.company_id,
          });
          await this.closeSession(session.id);
          return {
            reply: `${rescheduleResult}\n\nPor favor, chegue com 15 minutos de antecedência no local.`,
          };
        } else {
          await this.updateSessionStage(
            session.id,
            "ask_new_date",
            collectedData,
          );
          return {
            reply:
              "Sem problemas! O reagendamento foi pausado. Para qual outra data você deseja alterar? 📅",
          };
        }

      default:
        await this.updateSessionStage(session.id, "menu", {});
        return {
          reply:
            "Opção inválida ou sessão expirada. Vamos recomeçar?\n\n*1* - Novo Agendamento\n*2* - Reagendar Serviço",
        };
    }
  },

  // ------------------------------------------------------------------------
  // MOTOR NLU E AUXILIARES DE ESTADO
  // ------------------------------------------------------------------------

  extractData: async function (text, contextType) {
    const diasSemana = [
      "Domingo",
      "Segunda",
      "Terça",
      "Quarta",
      "Quinta",
      "Sexta",
      "Sábado",
    ];
    const hojeNome = diasSemana[moment().day()];
    const dateNow = moment().format("YYYY-MM-DD");

    let prompt = `Output: JSON estrito. Hoje: ${hojeNome}, ${dateNow}. `;

    if (contextType === "service_search") {
      prompt += `Ação: Extraia o serviço desejado.
            Retorne: 
            - "queries" (array de strings): Palavras-chave isoladas do serviço (Ex: 'Corte masculino' -> ['corte', 'masculino']).
            - "city" (string|null): Cidade mencionada.`;
    } else if (contextType === "date") {
      prompt += `Ação: Extraia a data e hora alvo. 
            Regras: Converta dias relativos (amanhã, domingo) em data exata. Se pedir um dia que já passou, use o da PRÓXIMA semana. IMPORTANTE: Se o usuário informar APENAS um horário (ex: "para as 16", "às 15h") e não mencionar palavras como "hoje", "amanhã" ou um dia específico, retorne "date": null e extraia apenas o "time".
            Retorne:
            - "date" (string|null): Formato YYYY-MM-DD.
            - "time" (string|null): Formato HH:mm (ex: "às 14", "de tarde").`;
    } else if (contextType === "time") {
      prompt += `Ação: Extraia o horário.
            Retorne:
            - "time" (string|null): Formato HH:mm.`;
    } else if (contextType === "customer_data") {
      prompt += `Ação: Extraia dados pessoais.
            Retorne:
            - "name" (string): Nome completo.
            - "cpf" (string): Apenas números.
            - "birthday" (string|null): Formato YYYY-MM-DD.`;
    }

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-5-nano",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: text },
        ],
      });
      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      console.error("[NLU Error]", error);
      return {};
    }
  },

  validateAndProceedReschedule: async function (session, collectedData) {
    const app = collectedData.selected_appointment;
    const diffHoras = moment(app.date).diff(moment(), "hours");

    if (diffHoras < 12) {
      await this.updateSessionStage(session.id, "menu", {});
      return {
        reply: `Seu agendamento atual é para *${moment(app.date).format("DD/MM [às] HH:mm")}*.\n\nPela nossa política, reagendamentos só podem ser feitos com pelo menos 12h de antecedência. 😕\n\nDeseja realizar um novo agendamento?\n*1* - Novo Agendamento\n*2* - Consultar outro CPF`,
      };
    }

    await this.updateSessionStage(session.id, "ask_new_date", collectedData);
    return {
      reply: `Seu agendamento em *${app.company_name}* (${moment(app.date).format("DD/MM [às] HH:mm")}) está elegível para alteração.\n\nPara qual nova data você deseja mudar? 📅`,
    };
  },

  getOrCreateSession: async function (phone) {
    let results = await functions.executeSql(
      `SELECT id, stage, collected_data, updated_at FROM whatsapp_sessions WHERE phone = ? AND status = 'active'`,
      [phone],
    );

    if (results.length > 0) {
      const lastUpdate = moment(results[0].updated_at || new Date());
      const minutesInactive = moment().diff(lastUpdate, "minutes");

      if (minutesInactive > 30) {
        await functions.executeSql(
          `UPDATE whatsapp_sessions SET status = 'expired' WHERE id = ?`,
          [results[0].id],
        );
        return this.createNewSession(phone);
      } else {
        return {
          id: results[0].id,
          stage: results[0].stage,
          collected_data: results[0].collected_data
            ? JSON.parse(results[0].collected_data)
            : {},
        };
      }
    }
    return this.createNewSession(phone);
  },

  createNewSession: async function (phone) {
    let insertResult = await functions.executeSql(
      `INSERT INTO whatsapp_sessions (phone, messages, status, stage, collected_data) VALUES (?, '[]', 'active', 'menu', '{}')`,
      [phone],
    );
    return { id: insertResult.insertId, stage: "menu", collected_data: {} };
  },

  updateSessionStage: async function (sessionId, stage, collectedData) {
    await functions.executeSql(
      `UPDATE whatsapp_sessions SET stage = ?, collected_data = ? WHERE id = ?`,
      [stage, JSON.stringify(collectedData), sessionId],
    );
  },

  closeSession: async function (sessionId) {
    await functions.executeSql(
      `UPDATE whatsapp_sessions SET status = 'closed' WHERE id = ?`,
      [sessionId],
    );
  },

  // ------------------------------------------------------------------------
  // INTEGRAÇÕES COM O BANCO DE DADOS
  // ------------------------------------------------------------------------

  findServicesInDB: async function (queries, city) {
    let orClauses = [];
    let relevanceCases = [];
    let params = [];
    let relevanceParams = [];

    if (!Array.isArray(queries)) {
      queries = [queries || ""];
    }

    queries.forEach((q) => {
      const term = `%${q.trim()}%`;

      orClauses.push(`s.name LIKE ?`);
      params.push(term);

      relevanceCases.push(`IF(s.name LIKE ?, 1, 0)`);
      relevanceParams.push(term);
    });

    let finalParams = [...relevanceParams, ...params];

    let sql = `
            SELECT s.id, s.name, s.value, s.duration, c.id as company_id, c.name as company_name, c.city,
            (${relevanceCases.join(" + ")}) as relevance
            FROM services s
            INNER JOIN companies c ON s.company_id = c.id
            WHERE (${orClauses.join(" OR ")})
        `;

    if (city) {
      sql += ` AND c.city LIKE ?`;
      finalParams.push(`%${city}%`);
    }

    sql += ` ORDER BY relevance DESC LIMIT 5`;

    console.log(
      `\n[BANCO - BUSCA DE SERVIÇO] Iniciando busca por RELEVÂNCIA...`,
    );
    console.log(`[BANCO - BUSCA DE SERVIÇO] Termos buscados (OR):`, queries);
    console.log(`[BANCO - SQL Gerado]:`, sql);

    const results = await functions.executeSql(sql, finalParams);

    console.log(
      `[BANCO - BUSCA DE SERVIÇO] Total encontrados (bruto): ${results.length}`,
    );

    let finalResults = [];

    if (results.length > 0) {
      const maxScore = results[0].relevance;

      finalResults = results.filter((r) => r.relevance === maxScore);

      console.log(
        `[BANCO - BUSCA DE SERVIÇO] Nota Máxima alcançada: ${maxScore}`,
      );
      console.log(
        `[BANCO - BUSCA DE SERVIÇO] Filtrados pelo grau máximo: ${finalResults.length}`,
      );

      finalResults.forEach((r) =>
        console.log(
          `  -> ID: ${r.id} | Nome: "${r.name}" | Nota de Match: ${r.relevance} | Empresa: ${r.company_name}`,
        ),
      );
    }
    console.log(`------------------------------------------------------\n`);

    return finalResults;
  },

  calculateFreeSlots: async function (
    company_id,
    date,
    duration,
    targetTime = null,
  ) {
    const data = await this.getCompanyScheduleAndAppointments(company_id, date);
    const dayOfWeek = moment(date, "YYYY-MM-DD").day();
    const hours = data.openingHours.find((h) => h.day === dayOfWeek);

    if (!hours) return { slots: [] };

    let startTimeStr = targetTime
      ? `${date} ${targetTime}:00`
      : `${date} ${hours.initial_date}`;
    let current = moment(startTimeStr, "YYYY-MM-DD HH:mm:ss");
    const end = moment(`${date} ${hours.final_date}`, "YYYY-MM-DD HH:mm:ss");
    const opening = moment(
      `${date} ${hours.initial_date}`,
      "YYYY-MM-DD HH:mm:ss",
    );

    if (current.isBefore(opening)) current = opening;

    let slots = [];
    while (current.clone().add(duration, "minutes").isSameOrBefore(end)) {
      const slotStart = current.format("YYYY-MM-DD HH:mm:ss");
      const slotEnd = current
        .clone()
        .add(duration, "minutes")
        .format("YYYY-MM-DD HH:mm:ss");
      const isBusy = data.appointments.some(
        (app) => slotStart < app.end && slotEnd > app.start,
      );

      if (!isBusy) slots.push(current.format("HH:mm"));
      current.add(30, "minutes");
    }
    return { slots };
  },

  processBooking: async function (phone, args) {
    const {
      company_id,
      customer_name,
      customer_birthday,
      customer_cpf,
      date,
      duration,
      total_value,
      services,
    } = args;

    const requestedDate = date.split(" ")[0];
    const requestedTime = date.split(" ")[1].substring(0, 5);
    const safeDuration = parseInt(duration) || 30;

    const availability = await this.calculateFreeSlots(
      company_id,
      requestedDate,
      safeDuration,
      requestedTime,
    );
    if (!availability.slots.includes(requestedTime)) {
      return "Infelizmente este horário foi preenchido por outra pessoa enquanto conversávamos. Podemos verificar outro momento?";
    }

    const customerId = await this.getOrCreateCustomer(
      phone,
      customer_name,
      customer_birthday,
      customer_cpf,
      company_id,
    );
    const prefResult = await functions.executeSql(
      `SELECT ccp.active FROM config_companies_preferences ccp INNER JOIN preferences p ON p.id = ccp.preference_id WHERE ccp.company_id = ? AND p.code = 'require_payment_on_booking'`,
      [company_id],
    );

    try {
      if (prefResult.length > 0 && prefResult[0].active === 1) {
        const paymentLink = await _asaasService.createPaymentLink(
          customerId,
          total_value,
        );
        return `PAGAMENTO_PENDENTE|${paymentLink.url}`;
      } else {
        await _appointmentsService.create(
          company_id,
          customerId,
          customer_name,
          date,
          safeDuration,
          "",
          services,
          "agendado",
          null,
        );
        return "SUCESSO";
      }
    } catch (error) {
      return `Ocorreu um erro no nosso sistema ao registrar: ${error.message || "Falha na inserção"}.`;
    }
  },

  processReschedule: async function (args) {
    const { appointment_id, new_date } = args;

    const app = await functions.executeSql(
      `SELECT date, duration, company_id, status FROM appointment_status_view WHERE id = ?`,
      [appointment_id],
    );

    if (app.length === 0) return "Agendamento não encontrado.";
    if (app[0].status !== "agendado")
      return `O reagendamento não é permitido, pois o status atual consta como '${app[0].status}'.`;

    const requestedDate = new_date.split(" ")[0];
    const requestedTime = new_date.split(" ")[1].substring(0, 5);

    const availability = await this.calculateFreeSlots(
      app[0].company_id,
      requestedDate,
      app[0].duration,
      requestedTime,
    );

    if (!availability.slots.includes(requestedTime)) {
      return "O novo horário escolhido acabou de ficar indisponível.";
    }

    await functions.executeSql(
      `UPDATE appointments SET date = ?, notified_1h = 0 WHERE id = ?`,
      [new_date, appointment_id],
    );
    return (
      "Prontinho! Seu agendamento foi reagendado para " +
      moment(new_date).format("DD/MM [às] HH:mm") +
      " com sucesso."
    );
  },

  getCustomerAppointments: async function (phone, cpf = null) {
    let sql = `
            SELECT a.id as appointment_id, a.date, a.duration, c.name as company_name, a.company_id
            FROM appointment_status_view a
            INNER JOIN customers cust ON a.customer_id = cust.id
            INNER JOIN companies c ON a.company_id = c.id
            WHERE (cust.tel = ? OR cust.cpf = ?) 
            AND a.date > NOW() 
            AND a.status = 'agendado'
            ORDER BY a.date ASC
        `;
    return await functions.executeSql(sql, [phone, cpf]);
  },

  getCompanyScheduleAndAppointments: async function (company_id, date) {
    const openingHours = await functions.executeSql(
      `SELECT day, initial_date, final_date FROM config_companies_schedule WHERE company_id = ?`,
      [company_id],
    );
    const appointments = await _appointmentsService.getAllByCompany(
      company_id,
      false,
      date,
    );
    const optimizedAppointments = appointments.map((app) => ({
      start: app.start,
      end: app.end,
    }));
    return { openingHours, appointments: optimizedAppointments };
  },

  getOrCreateCustomer: async function (phone, name, birthday, cpf, company_id) {
    const cleanCpf = cpf ? cpf.replace(/\D/g, "") : "00000000000";
    let formattedBirthday =
      birthday && birthday.includes("-")
        ? `${birthday} 00:00:00`
        : "1900-01-01 00:00:00";

    let results = await functions.executeSql(
      `SELECT id FROM customers WHERE cpf = ?`,
      [cleanCpf],
    );
    if (results.length > 0) return results[0].id;

    results = await functions.executeSql(
      `INSERT INTO customers (name, birthday, tel, company_id, cpf) VALUES (?, ?, ?, ?, ?)`,
      [
        name || "Cliente WhatsApp",
        formattedBirthday,
        phone,
        company_id,
        cleanCpf,
      ],
    );

    return results.insertId;
  },
};

module.exports = openaiService;
