const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const validate = require("../middleware/validate");
const _companiesService = require("../services/companiesService");
const functions = require("../utils/functions");
const _asaasService = require("../services/asaasService");

router.get("/", login, validate.validateCompanyAccess, (req, res, next) => {
    _companiesService.returnCompany(req.headers['selected-company'], req.usuario.id).then((results) => {
        let response = functions.createResponse("Retorno da empresa solicitada", results, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.post("/create_company", login, validate.validateRequest(validate.schemas.companies.createCompany), (req, res, next) => {
    _companiesService.createCompany(req.usuario.id, req.body).then(() => {
        let response = functions.createResponse("Empresa criada com sucesso", null, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send({ message: error.message || error });
    })
});

router.patch("/:company_id", login, validate.validateRequest(validate.schemas.companies.editCompany), (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.params.company_id).then(() => {
        _companiesService.editCompany(req.usuario.id, req.params.company_id, req.body.name, req.body.address, req.body.city, req.body.state, req.body.business_type, req.body.zip_code, req.body.configurations).then(() => {
            let response = functions.createResponse("Empresa alterada com sucesso", null, "PATCH", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.get("/business_types", (req, res, next) => {
    _companiesService.returnBusinessTypes().then((results) => {
        let response = functions.createResponse("Retorno dos tipos de negócio", results, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.post("/roles", login, validate.validateRequest(validate.schemas.companies.createRole), (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.createRole(req.headers['selected-company'], req.body.name, req.body.permission).then(() => {
            let response = functions.createResponse("Cargo criado com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.get("/roles", login, validate.validateCompanyAccess, (req, res, next) => {
    _companiesService.returnCompanyRoles(req.headers['selected-company']).then(() => {
        let response = functions.createResponse("Cargo criado com sucesso", null, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.post("/roles/:id", login, validate.validateRequest(validate.schemas.companies.editRole), (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.editRole(req.headers['selected-company'], req.body.id, req.body.name, req.body.permission).then(() => {
            let response = functions.createResponse("Cargo salvo com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.delete("/roles/:id", login, (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.excludeRole(req.headers['selected-company'], req.params.id).then(() => {
            let response = functions.createResponse("Cargo excluído com sucesso", null, "DELETE", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.get("/return_users", login, (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.returnCompanyUsers(req.headers['selected-company']).then((results) => {
            let response = functions.createResponse("Retorno dos membros da empresa", results, "GET", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.post("/invite_user", login, validate.validateRequest(validate.schemas.companies.inviteUser), (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.inviteUser(req.headers['selected-company'], req.body.name, req.body.id, req.body.email, req.usuario.id, req.body.role).then(() => {
            let response = functions.createResponse("Convite enviado com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.post("/change_user_role", login, validate.validateRequest(validate.schemas.companies.editUser), (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.changeUserRole(req.body.role, req.body.id, req.headers['selected-company']).then(() => {
            let response = functions.createResponse("Cargo do usuário alterado com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.post("/find_user_by_token", (req, res, next) => {
    _companiesService.findUserByToken(req.body.token, req.body.email).then((results) => {
        let response = functions.createResponse("Verificação de existência do usuário", results, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.post("/enter_company", (req, res, next) => {
    _companiesService.enterCompany(req.body.token, req.body.email).then(() => {
        let response = functions.createResponse("Acesso à empresa liberado", null, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.delete("/remove_user/:user_id", login, (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.removeUserFromCompany(req.headers['selected-company'], req.params.user_id, req.usuario.id).then(() => {
            let response = functions.createResponse("Usuário removido com sucesso", null, "DELETE", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.post("/services", login, validate.validateRequest(validate.schemas.services.create), (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.createService(req.headers['selected-company'], req.body.name, req.body.value, req.body.cost, req.body.observations, req.body.duration, req.body.requires_location, req.body.accepts_quantity, req.body.measurement_unit_id).then(() => {
            _companiesService.returnCompany(req.headers['selected-company'], req.usuario.id, true).catch(() => {});
            let response = functions.createResponse("Serviço criado com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        });
    }).catch((error) => {
        return res.status(401).send(error);
    });
});

router.get("/services", login, validate.validateCompanyAccess, (req, res, next) => {
    _companiesService.returnCompanyServices(req.headers['selected-company']).then((services) => {
        let response = functions.createResponse("Serviços retornados com sucesso", services, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

router.post("/services/:id", login, validate.validateRequest(validate.schemas.services.create), (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.editService(req.headers['selected-company'], req.params.id, req.body.name, req.body.value, req.body.cost, req.body.observations, req.body.duration, req.body.requires_location, req.body.accepts_quantity, req.body.measurement_unit_id).then(() => {
            let response = functions.createResponse("Serviço atualizado com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        });
    }).catch((error) => {
        return res.status(401).send(error);
    });
});

router.delete("/services/:id", login, (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.excludeService(req.headers['selected-company'], req.params.id).then(() => {
            let response = functions.createResponse("Serviço excluído com sucesso", null, "DELETE", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        });
    }).catch((error) => {
        return res.status(401).send(error);
    });
});

router.get("/preferences", login, (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.getPreferences(req.headers['selected-company']).then((results) => {
            let response = functions.createResponse("Retorno das preferências", results, "GET", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        });
    }).catch((error) => {
        return res.status(401).send(error);
    });
});

router.post("/preferences", login, validate.validateCompanyAccess, (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.setPreferences(req.headers['selected-company'], req.body.preferences).then(() => {
            
            _companiesService.returnCompany(req.headers['selected-company'], req.usuario.id, true).catch(() => {});
            
            let response = functions.createResponse("Preferências atualizadas com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        });
    }).catch((error) => {
        return res.status(401).send(error);
    });
});

router.post("/products", login, validate.validateRequest(validate.schemas.products.create), (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.createProduct(req.headers['selected-company'], req.body.name, req.body.value, req.body.cost, req.body.description, req.body.unit_of_measure).then(() => {
            let response = functions.createResponse("Produto criado com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        });
    }).catch((error) => {
        return res.status(401).send(error);
    });
});

router.get("/products", login, validate.validateCompanyAccess, (req, res, next) => {
    _companiesService.returnCompanyProducts(req.headers['selected-company']).then((services) => {
        let response = functions.createResponse("Produtos retornados com sucesso", services, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

router.post("/products/:id", login, validate.validateRequest(validate.schemas.products.create), (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.editProduct(req.headers['selected-company'], req.params.id, req.body.name, req.body.value, req.body.cost, req.body.description, req.body.unit_of_measure).then(() => {
            let response = functions.createResponse("Produto atualizado com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        });
    }).catch((error) => {
        return res.status(401).send(error);
    });
});

router.delete("/products/:id", login, (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.excludeProduct(req.headers['selected-company'], req.params.id).then(() => {
            let response = functions.createResponse("Produto excluído com sucesso", null, "DELETE", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        });
    }).catch((error) => {
        return res.status(401).send(error);
    });
});

router.delete("/:id", login, (req, res, next) => {
    const company_id = req.params.id;
    const user_id = req.usuario.id;

    _companiesService.deleteCompany(user_id, company_id).then(() => {
        let response = functions.createResponse("Empresa excluída permanentemente.", null, "DELETE", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(400).send({ message: error });
    });
});

router.get("/asaas_status", login, validate.validateCompanyAccess, (req, res, next) => {
    _companiesService.checkAsaasStatus(req.headers['selected-company']).then((asaasData) => {
        let response = functions.createResponse("Status retornado com sucesso", asaasData, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        console.log(error)
        return res.status(500).send({ message: "Erro ao consultar status da conta." });
    });
});

router.get("/admin/sync_webhooks", async (req, res) => {
    try {
        const wallets = await functions.executeSql(`SELECT asaas_api_key FROM asaas_wallets WHERE asaas_api_key IS NOT NULL`);
        let sucessos = 0;
        let erros = 0;
        let detalhesErro = []; // Lista para guardar os motivos

        for (let wallet of wallets) {
            try {
                await _asaasService.createWebhook(wallet.asaas_api_key);
                sucessos++;
            } catch (e) {
                erros++;
                // Pega a resposta exata de erro do Asaas
                detalhesErro.push(e.response?.data || e.message);
            }
        }

        return res.status(200).send({
            mensagem: `Sincronização concluída. Sucessos: ${sucessos}, Erros: ${erros}`,
            motivos: detalhesErro
        });
    } catch (error) {
        return res.status(500).send(error);
    }
});

module.exports = router;