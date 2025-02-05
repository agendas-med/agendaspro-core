const errors = {
    string: {
        empty: () => "O campo é obrigatório.",
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
        integer: () => "O campo deve ser um número inteiro."
    }
};

module.exports = errors;
