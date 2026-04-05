const { OpenAI } = require("openai");
const functions = require("../utils/functions");
const _appointmentsService = require("./appointmentsService");
const _asaasService = require("./asaasService");
const moment = require("moment");
const axios = require("axios");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const UNIT_QUESTIONS = {
  unidade: "Para quantas unidades seria o agendamento?",
  pessoa: "Para quantas pessoas seria?",
  peca: "Quantas peças seriam no total?",
  hora: "Para quantas horas de serviço?",
  sessao: "Quantas sessões você gostaria de agendar?",
  m2: "Qual é a metragem total (em metros quadrados)?",
  km: "Qual é a distância total em quilômetros?",
};

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
          return await this.handleServiceRouting(session, collectedData);
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
          await this.updateSessionStage(
            session.id,
            "ask_service_details",
            collectedData,
          );
          return await this.processWhatsAppMessage(phone, msgClean);
        }

        collectedData.selected_service = collectedData.temp_services[srvIdx];
        delete collectedData.temp_services;

        return await this.handleServiceRouting(session, collectedData);

      case "ask_quantity":
        const qtyInfo = await this.extractData(msgClean, "quantity_data");
        const extractedQuantity = qtyInfo.quantity || 1;

        collectedData.quantity = extractedQuantity;
        collectedData.selected_service.quantity = extractedQuantity;

        return await this.handleServiceRouting(session, collectedData);

      case "ask_service_location":
        const newLocInfo = await this.extractData(msgClean, "location_data");

        if (!collectedData.addressData) {
          collectedData.addressData = {};
        }

        if (newLocInfo.zip_code)
          collectedData.addressData.zip_code = newLocInfo.zip_code;
        if (newLocInfo.address)
          collectedData.addressData.address = newLocInfo.address;
        if (newLocInfo.number)
          collectedData.addressData.number = newLocInfo.number;
        if (newLocInfo.complement)
          collectedData.addressData.complement = newLocInfo.complement;
        if (newLocInfo.city) collectedData.addressData.city = newLocInfo.city;
        if (newLocInfo.state)
          collectedData.addressData.state = newLocInfo.state;

        const currentLoc = collectedData.addressData;

        if (currentLoc.zip_code && !currentLoc.address) {
          try {
            const cleanCep = currentLoc.zip_code.replace(/\D/g, "");

            if (cleanCep.length === 8) {
              const cepResponse = await axios.get(
                `https://viacep.com.br/ws/${cleanCep}/json/`,
              );
              const cepData = cepResponse.data;

              if (!cepData.erro) {
                currentLoc.address = currentLoc.address || cepData.logradouro;
                currentLoc.city = currentLoc.city || cepData.localidade;
                currentLoc.state = currentLoc.state || cepData.uf;
                currentLoc.neighborhood =
                  currentLoc.neighborhood || cepData.bairro;
              }
            }
          } catch (error) {
            console.error("[ViaCEP Error]: Falha ao buscar CEP", error);
          }
        }

        if (!currentLoc.number) {
          await this.updateSessionStage(
            session.id,
            "ask_service_location",
            collectedData,
          );
          return {
            reply:
              "Preciso que me informe o *Número* do local para enviar o profissional (ou responda 'sem número' se for o caso).",
          };
        }

        if (!currentLoc.address && !currentLoc.zip_code) {
          await this.updateSessionStage(
            session.id,
            "ask_service_location",
            collectedData,
          );
          return {
            reply:
              "Por favor, me informe o *CEP* ou o *Nome da Rua* para que eu possa localizar o endereço.",
          };
        }

        if (!currentLoc.address) {
          await this.updateSessionStage(
            session.id,
            "ask_service_location",
            collectedData,
          );
          return {
            reply:
              "Não consegui encontrar sua rua através do CEP informado. Pode me dizer o *Nome da Rua e o Número*?",
          };
        }

        await this.updateSessionStage(session.id, "ask_date", collectedData);

        return {
          reply:
            "Endereço anotado! 🗺️\n\nAgora, para qual data você deseja agendar? (Ex: amanhã, 20/05)",
        };

      case "ask_date":
        const dateInfo = await this.extractData(msgClean, "date");

        if (dateInfo.change_service && dateInfo.new_service) {
          collectedData.last_queries = dateInfo.new_service;
          await this.updateSessionStage(
            session.id,
            "ask_service_details",
            collectedData,
          );
          return await this.processWhatsAppMessage(
            phone,
            dateInfo.new_service.join(" "),
          );
        }

        if (dateInfo.next_available) {
          let daysChecked = 0;
          let foundDays = [];

          let searchDate = dateInfo.date
            ? moment(dateInfo.date, "YYYY-MM-DD")
            : moment();

          if (searchDate.isBefore(moment(), "day")) {
            searchDate = moment();
          }

          while (daysChecked < 15 && foundDays.length < 3) {
            let checkStr = searchDate.format("YYYY-MM-DD");
            let avail = await this.calculateFreeSlots(
              collectedData.selected_service.company_id,
              checkStr,
              collectedData.selected_service.duration,
            );

            if (avail.slots.length > 0) {
              foundDays.push({
                date: checkStr,
                slots: avail.slots.slice(0, 7),
              });
            }
            searchDate.add(1, "days");
            daysChecked++;
          }

          if (foundDays.length === 0) {
            return {
              reply:
                "Infelizmente, não encontrei nenhum horário disponível nas próximas semanas para o período solicitado. 😕",
            };
          }

          let openReply =
            "Temos estes dias e horários mais próximos disponíveis:\n\n";
          const diasNomes = [
            "Domingo",
            "Segunda",
            "Terça",
            "Quarta",
            "Quinta",
            "Sexta",
            "Sábado",
          ];

          foundDays.forEach((fd) => {
            const nomeDiaSemana = diasNomes[moment(fd.date).day()];
            openReply += `*${moment(fd.date).format("DD/MM")} (${nomeDiaSemana})*: ${fd.slots.join(" | ")}\n`;
          });

          openReply +=
            "\nQual dia e horário você prefere? (Ex: segunda às 10h)";
          return { reply: openReply };
        }

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

        if (
          targetDate &&
          moment(targetDate).isBefore(moment().format("YYYY-MM-DD"))
        ) {
          return {
            reply:
              "Não é possível agendar para uma data que já passou. 😅 Por favor, escolha uma data de hoje em diante.",
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
              reply: `Excelente! O horário das ${collectedData.time} está disponível e já reservei para você.\n\nPara eu finalizar no sistema, por favor, me informe na mesma mensagem o seu *Nome Completo*, *Data de Nascimento*, *CPF* e *E-mail*.`,
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

        if (timeInfo.change_service && timeInfo.new_service) {
          collectedData.last_queries = timeInfo.new_service;
          await this.updateSessionStage(
            session.id,
            "ask_service_details",
            collectedData,
          );
          return await this.processWhatsAppMessage(
            phone,
            timeInfo.new_service.join(" "),
          );
        }

        if (timeInfo.date) {
          await this.updateSessionStage(session.id, "ask_date", collectedData);
          return await this.processWhatsAppMessage(phone, msgClean);
        }

        if (!timeInfo.time) {
          return {
            reply: `Não consegui identificar o horário desejado. Por favor, escolha um desta lista:\n*${collectedData.temp_slots.join(" | ")}*\n\n(Ou se preferir, me diga outro dia da semana!)`,
          };
        }

        if (!collectedData.temp_slots.includes(timeInfo.time)) {
          return {
            reply: `Poxa, às ${timeInfo.time} nós não temos disponibilidade neste dia. 😕\n\nNossos horários livres são:\n*${collectedData.temp_slots.join(" | ")}*\n\nAlgum desses fica bom para você?`,
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
            reply: `Horário das ${collectedData.time} reservado! Para finalizar o agendamento no sistema, por favor, me informe na mesma mensagem o seu *Nome Completo*, *Data de Nascimento*, *CPF* e *E-mail*.`,
          };
        }

      case "ask_customer_data":
        const srv = collectedData.selected_service;
        const newCustomerInfo = await this.extractData(
          msgClean,
          "customer_data",
        );

        if (!collectedData.customerInfo) {
          collectedData.customerInfo = {};
        }

        if (newCustomerInfo.name && newCustomerInfo.name.length > 2) {
          collectedData.customerInfo.name = newCustomerInfo.name;
        }
        if (newCustomerInfo.cpf) {
          collectedData.customerInfo.cpf = newCustomerInfo.cpf;
        }
        if (newCustomerInfo.email && newCustomerInfo.email.includes("@")) {
          collectedData.customerInfo.email = newCustomerInfo.email;
        }
        if (newCustomerInfo.birthday) {
          collectedData.customerInfo.birthday = newCustomerInfo.birthday;
        }

        let missingFields = [];
        let invalidFields = [];

        if (!collectedData.customerInfo.name)
          missingFields.push("Nome Completo");

        if (!collectedData.customerInfo.cpf) {
          missingFields.push("CPF");
        } else {
          const cleanCpf = collectedData.customerInfo.cpf.replace(/\D/g, "");
          if (cleanCpf.length !== 11) {
            invalidFields.push("CPF (inválido)");
            collectedData.customerInfo.cpf = null;
          }
        }

        if (!collectedData.customerInfo.email) {
          missingFields.push("E-mail");
        } else {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(collectedData.customerInfo.email)) {
            invalidFields.push("E-mail (formato inválido)");
            collectedData.customerInfo.email = null;
          }
        }

        if (!collectedData.customerInfo.birthday) {
          missingFields.push("Data de Nascimento");
        } else {
          if (
            !moment(
              collectedData.customerInfo.birthday,
              "YYYY-MM-DD",
              true,
            ).isValid()
          ) {
            invalidFields.push("Data de Nascimento (formato inválido)");
            collectedData.customerInfo.birthday = null;
          }
        }

        if (missingFields.length > 0 || invalidFields.length > 0) {
          await this.updateSessionStage(
            session.id,
            "ask_customer_data",
            collectedData,
          );

          let replyMsg = "Quase lá! ";
          if (invalidFields.length > 0) {
            replyMsg += `Notei que as seguintes informações estão em formato incorreto: *${invalidFields.join(", ")}*. `;
          }
          if (missingFields.length > 0) {
            replyMsg += `Também faltou me informar: *${missingFields.join(", ")}*. `;
          }

          replyMsg += `\n\nPode me enviar os dados corretos para eu concluir a sua reserva?`;
          return { reply: replyMsg };
        }

        const bookingResult = await this.processBooking(phone, {
          company_id: srv.company_id,
          customer_name: collectedData.customerInfo.name,
          customer_birthday: collectedData.customerInfo.birthday,
          customer_cpf: collectedData.customerInfo.cpf,
          customer_email: collectedData.customerInfo.email,
          date: `${collectedData.date} ${collectedData.time}:00`,
          duration: srv.duration,
          services: [
            {
              id: srv.id,
              name: srv.name,
              value: srv.value,
              duration: srv.duration,
              quantity: collectedData.quantity || 1,
            },
          ],
          addressData: collectedData.addressData || null,
        });

        if (
          bookingResult.startsWith("Ocorreu um erro") ||
          bookingResult.includes("Infelizmente")
        ) {
          return { reply: bookingResult };
        }

        await this.closeSession(session.id);

        if (bookingResult.includes("PAGAMENTO_PENDENTE|")) {
          const urlPagamento = bookingResult.split("|")[1];
          return {
            reply: `Tudo certo, ${collectedData.customerInfo.name.split(" ")[0]}! 🎉\n\nPara confirmar a sua reserva e garantir o horário, realize o pagamento do sinal de confirmação acessando o link abaixo:\n\n🔗 ${urlPagamento}\n\nAssim que o pagamento for identificado, seu agendamento estará 100% confirmado!`,
          };
        }

        return {
          reply: `Prontinho, ${collectedData.customerInfo.name.split(" ")[0]}! Seu agendamento foi concluído com sucesso. 🎉\n\nTe esperamos no dia e horário combinados!\n\n*Lembre-se de chegar ao local com 15 minutos de antecedência.*`,
        };

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

        if (
          targetNewDate &&
          moment(targetNewDate).isBefore(moment().format("YYYY-MM-DD"))
        ) {
          return {
            reply:
              "Não é possível agendar para uma data que já passou. 😅 Por favor, escolha uma data de hoje em diante.",
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

  handleServiceRouting: async function (session, collectedData) {
    const srv = collectedData.selected_service;

    if (srv.accepts_quantity && !collectedData.quantity) {
      await this.updateSessionStage(session.id, "ask_quantity", collectedData);
      const question =
        UNIT_QUESTIONS[srv.measurement_unit] || UNIT_QUESTIONS["unidade"];
      return {
        reply: `Ótimo! O serviço *${srv.name}* possui cobrança variável.\n\n${question}`,
      };
    }

    if (srv.requires_location && !collectedData.addressData) {
      await this.updateSessionStage(
        session.id,
        "ask_service_location",
        collectedData,
      );
      return {
        reply: `Serviço *${srv.name}* selecionado!\n\n📍 *Atenção:* Este serviço é realizado em domicílio!\nPor favor, me informe o endereço completo: *Rua, Número, CEP e Complemento*.`,
      };
    }

    await this.updateSessionStage(session.id, "ask_date", collectedData);
    return {
      reply: `Serviço *${srv.name}* selecionado!\n\nPara qual data você deseja agendar? (Ex: amanhã, 20/05)`,
    };
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
      prompt += `Ação: Extraia o serviço e a quantidade (se mencionada).
            Retorne: 
            - "queries" (array de strings): Palavras-chave isoladas do serviço (Ex: 'Corte masculino' -> ['corte', 'masculino']).
            - "city" (string|null): Cidade mencionada.
            - "quantity": number|1`;
    } else if (contextType === "quantity") {
      prompt += `Ação: Extraia a quantidade desejada.
            Retorne:
            - "quantity" (number|null): O número extraído.`;
    } else if (contextType === "date") {
      prompt += `Ação: Extraia a data/hora, detecte mudança de serviço e detecte busca aberta de horários.
            Regras: Converta termos relativos (amanhã, segunda, domingo) em data exata. 
            // NOVA REGRA ADICIONADA ABAIXO:
            IMPORTANTE: SEMPRE assuma datas no futuro. Se hoje é Sábado e o cliente pedir "Domingo", a data é o próximo domingo, nunca no passado.
            Se informar APENAS horário, retorne "date": null e extraia o "time".
            MUDANÇA DE SERVIÇO: Se pedir um serviço diferente, defina "change_service": true.
            BUSCA ABERTA (Períodos ou Próximos): Se o usuário fizer uma busca ampla (ex: "pra quando tem?", "semana que vem", "mês que vem", "a partir do dia X"), defina "next_available": true e defina "date" como a data de início dessa busca (ex: próxima segunda, dia 1 do próximo mês). Se for apenas "pra quando tem?", "date" pode ser null.
            Retorne:
            - "date" (string|null): Formato YYYY-MM-DD.
            - "time" (string|null): Formato HH:mm.
            - "change_service" (boolean)
            - "new_service" (array de strings|null)
            - "next_available" (boolean)`;
    } else if (contextType === "time") {
      prompt += `Ação: Extraia o horário.
            Retorne:
            - "time" (string|null): Formato HH:mm.`;
    } else if (contextType === "customer_data") {
      prompt += `Ação: Extraia dados pessoais.
            Retorne:
            - "name" (string): Nome completo.
            - "cpf" (string): Apenas números.
            - "birthday" (string|null): Formato YYYY-MM-DD.
            - "email" (string|null): Endereço de e-mail.`;
    } else if (contextType === "location_data") {
      prompt += `Ação: Extraia dados de endereço de atendimento a domicílio.
            Retorne:
            - "zip_code" (string|null): CEP se informado (apenas números).
            - "address" (string|null): Nome da rua/avenida.
            - "number" (string|null): Número do local/imóvel (extraia sempre, se existir).
            - "complement" (string|null): Complemento (apto, bloco, casa 2).
            - "city" (string|null): Cidade.
            - "state" (string|null): Estado (Sigla UF).`;
    } else if (contextType === "quantity_data") {
      prompt += `Ação: Extraia a quantidade informada pelo cliente para o serviço.
            Retorne um JSON com:
            - "quantity" (number): Apenas o número inteiro exato (ex: 4). Se não conseguir identificar, retorne 1.`;
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
            SELECT s.id, s.name, s.value, s.duration, s.requires_location, s.accepts_quantity, s.measurement_unit, c.id as company_id, c.name as company_name, c.city,
            (${relevanceCases.join(" + ")}) as relevance
            FROM services s
            INNER JOIN companies c ON s.company_id = c.id
            WHERE c.asaas_status = 'APPROVED' AND (${orClauses.join(" OR ")})
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

    const dbDay = moment(date, "YYYY-MM-DD").day() + 1;

    const hoursList = data.openingHours.filter(
      (h) => parseInt(h.day) === dbDay,
    );

    if (hoursList.length === 0) return { slots: [] };

    const now = moment();
    const todayStr = now.format("YYYY-MM-DD");

    if (moment(date, "YYYY-MM-DD").isBefore(todayStr)) {
      return { slots: [] };
    }

    let slots = [];

    for (let hours of hoursList) {
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

      if (date === todayStr) {
        if (targetTime && current.isBefore(now)) {
          continue;
        }
        if (!targetTime && current.isBefore(now)) {
          const minutes = now.minute();
          const remainder = 30 - (minutes % 30);
          current = moment(now).add(remainder, "minutes").second(0);
        }
      }

      while (current.clone().add(duration, "minutes").isSameOrBefore(end)) {
        const mSlotStart = current.clone();
        const mSlotEnd = current.clone().add(duration, "minutes");

        const isBusy = data.appointments.some((app) => {
          const appStart = moment(app.start);
          const appEnd = moment(app.end);
          return mSlotStart.isBefore(appEnd) && mSlotEnd.isAfter(appStart);
        });

        if (!isBusy) {
          const timeStr = current.format("HH:mm");
          if (!slots.includes(timeStr)) slots.push(timeStr);
        }
        current.add(30, "minutes");
      }
    }

    slots.sort();

    if (targetTime) {
      return slots.includes(targetTime)
        ? { slots: [targetTime] }
        : { slots: [] };
    }

    return { slots };
  },

  processBooking: async function (phone, args) {
    const {
      company_id,
      customer_name,
      customer_birthday,
      customer_cpf,
      customer_email,
      date,
      duration,
      services,
      addressData,
      selected_service,
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

    const baseServices =
      services && services.length > 0 ? services : [selected_service];
    const serviceIds = baseServices.map((s) => s.id);

    const dbServices = await functions.executeSql(
      `SELECT id, value, accepts_quantity, name FROM services WHERE id IN (${serviceIds.join(",")})`,
    );

    let calculatedTotal = 0;

    const finalServices = baseServices.map((s) => {
      const dbSrv = dbServices.find((db) => db.id === s.id);

      const rawQuantity =
        s.quantity ||
        (selected_service && selected_service.id === s.id
          ? selected_service.quantity
          : 1);
      const qty =
        dbSrv.accepts_quantity && rawQuantity ? parseInt(rawQuantity) : 1;

      calculatedTotal += dbSrv.value * qty;

      return { ...s, name: dbSrv.name, value: dbSrv.value, quantity: qty };
    });

    const customerId = await this.getOrCreateCustomer(
      phone,
      customer_name,
      customer_birthday,
      customer_cpf,
      customer_email,
      company_id,
    );

    const prefResult = await functions.executeSql(
      `SELECT ccp.active FROM config_companies_preferences ccp INNER JOIN preferences p ON p.id = ccp.preference_id WHERE ccp.company_id = ? AND p.code = 'require_payment_on_booking'`,
      [company_id],
    );

    let newAppId = null;

    try {
      if (prefResult.length > 0 && prefResult[0].active === 1) {
        newAppId = await _appointmentsService.create(
          company_id,
          customerId,
          customer_name,
          date,
          safeDuration,
          "",
          finalServices,
          "agendado",
          addressData,
        );

        await functions.executeSql(
          `UPDATE appointments SET payment_status = 'pendente' WHERE id = ?`,
          [newAppId],
        );

        const companyData = await functions.executeSql(
          `SELECT asaas_api_key FROM companies WHERE id = ?`,
          [company_id],
        );
        const subaccountApiKey = companyData[0].asaas_api_key;

        if (!subaccountApiKey) {
          throw new Error(
            "A empresa ainda não configurou os recebimentos online. Por favor, tente novamente mais tarde.",
          );
        }

        const asaasCustomerId = await _asaasService.getOrCreateCustomer(
          {
            name: customer_name,
            cpf: customer_cpf,
            tel: phone,
            email: customer_email,
          },
          subaccountApiKey,
        );

        const firstService = finalServices[0];
        const descriptionString =
          firstService.quantity > 1
            ? `${firstService.name} (x${firstService.quantity})`
            : firstService.name;

        const paymentLink = await _asaasService.createPaymentLink(
          {
            customerAsaasId: asaasCustomerId,
            value: calculatedTotal,
            externalReference: `APP_${newAppId}`,
            description: `Agendamento - ${descriptionString}`,
          },
          subaccountApiKey,
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
          finalServices,
          "agendado",
          addressData,
        );
        return "SUCESSO";
      }
    } catch (error) {
      if (newAppId) {
        await functions.executeSql(`DELETE FROM appointments WHERE id = ?`, [
          newAppId,
        ]);
      }

      const msgErro = error.message
        ? error.message
        : typeof error === "string"
          ? error
          : "Falha na inserção";

      return `Ocorreu um erro no nosso sistema ao registrar: ${msgErro}.`;
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
    const dayMap = {
      1: "Domingo",
      2: "Segunda-feira",
      3: "Terça-feira",
      4: "Quarta-feira",
      5: "Quinta-feira",
      6: "Sexta-feira",
      7: "Sábado",
    };

    const dbDay = moment(date, "YYYY-MM-DD").day() + 1;
    const requestedDayName = dayMap[dbDay];

    const openingHoursRaw = await functions.executeSql(
      `SELECT day, initial_date, final_date FROM config_companies_schedule WHERE company_id = ?`,
      [company_id],
    );

    const openingHours = openingHoursRaw.map((item) => ({
      day: item.day,
      day_name: dayMap[item.day],
      initial_date: item.initial_date,
      final_date: item.final_date,
    }));

    const appointments = await _appointmentsService.getAllByCompany(
      company_id,
      false,
      date,
    );

    const optimizedAppointments = appointments
      .filter((app) => app.status !== "cancelado")
      .map((app) => ({
        start: app.start,
        end: app.end,
      }));

    return {
      requested_day_name: requestedDayName,
      openingHours,
      appointments: optimizedAppointments,
    };
  },

  getOrCreateCustomer: async function (
    phone,
    name,
    birthday,
    cpf,
    email,
    company_id,
  ) {
    const cleanCpf = cpf ? cpf.replace(/\D/g, "") : "00000000000";
    let formattedBirthday =
      birthday && birthday.includes("-")
        ? `${birthday} 00:00:00`
        : "1900-01-01 00:00:00";

    const finalName =
      name && name !== "Não Informado" ? name : "Cliente WhatsApp";

    let results = await functions.executeSql(
      `SELECT id, name FROM customers WHERE cpf = ? AND company_id = ?`,
      [cleanCpf, company_id],
    );

    if (results.length > 0) {
      const existing = results[0];
      if (
        !existing.name ||
        existing.name === "Não Informado" ||
        existing.name.length < 3
      ) {
        await functions.executeSql(
          `UPDATE customers SET name = ?, email = ?, birthday = ? WHERE id = ?`,
          [finalName, email || null, formattedBirthday, existing.id],
        );
      }
      return existing.id;
    }

    results = await functions.executeSql(
      `SELECT id FROM customers WHERE phone = ? AND company_id = ?`,
      [phone, company_id],
    );

    if (results.length > 0) {
      const existingId = results[0].id;
      await functions.executeSql(
        `UPDATE customers SET name = ?, cpf = ?, email = ?, birthday = ? WHERE id = ?`,
        [finalName, cleanCpf, email || null, formattedBirthday, existingId],
      );
      return existingId;
    }

    results = await functions.executeSql(
      `INSERT INTO customers (name, birthday, phone, company_id, cpf, email) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        finalName,
        formattedBirthday,
        phone,
        company_id,
        cleanCpf,
        email || null,
      ],
    );

    return results.insertId;
  },
};

module.exports = openaiService;
