const errors = {
    string: {
        empty: () => "O campo é obrigatório.",
        base: () => "O campo deve ser uma string.",
        min: (limit) => `O campo deve ter pelo menos ${limit} caracteres.`,
        max: (limit) => `O campo deve ter no máximo ${limit} caracteres.`,
        length: (limit) => `O campo deve ter exatamente ${limit} caracteres.`,
        pattern: () => "O formato do campo é inválido.",
        uppercase: () => "O campo deve estar em letras maiúsculas.",
        lowercase: () => "O campo deve estar em letras minúsculas.",
        alphanum: () => "O campo deve conter apenas letras e números.",
        email: () => "O e-mail informado é inválido.",
        url: () => "A URL informada é inválida.",
        uuid: () => "O identificador UUID informado é inválido.",
    },
    integer: {
        base: () => "O campo deve ser um número.",
        integer: () => "O campo deve ser um número inteiro.",
        min: (limit) => `O campo deve um numero maior ou igual a ${limit}.`,
        max: (limit) => `O campo deve um numero menor ou igual a ${limit}.`,
    },
    array: {
        base: () => "O campo deve ser um array."
    },
    boolean: {
        base: () => "O campo deve ser boolean."
    },
    object: {
        base: () => "O campo deve ser um objeto."
    }
};

module.exports = errors;
