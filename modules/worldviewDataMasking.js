/**
 * 对话世界观文档系统 - 数据脱敏模块
 * 
 * 在将对话内容发送给LLM生成摘要前，对敏感信息进行脱敏处理。
 * 防止AK/SK、Token、密码等敏感信息泄露。
 */

const DEBUG_MODE = process.env.VCP_WORLDVIEW_DEBUG === 'true';

const MASK_PATTERNS = [
    {
        name: 'AK/SK密钥',
        regex: /(?<![a-zA-Z0-9])(?:AK|SK|api[_-]?key|secret[_-]?key|access[_-]?key|app[_-]?key)[_-]?(?:id|token)?[\s:=]+["']?([a-zA-Z0-9_\-]{16,64})["']?/gi,
        replacement: '***AK/SK***'
    },
    {
        name: 'Bearer Token',
        regex: /(?:Bearer|bearer)[\s]+([a-zA-Z0-9_\-\.]{20,})/gi,
        replacement: '***TOKEN***'
    },
    {
        name: 'Password字段',
        regex: /(?:password|pwd|passwd|secret)[\s:=]+["']?([^\s'"]{4,64})["']?/gi,
        replacement: '***PASSWORD***'
    },
    {
        name: 'GitHub Token',
        regex: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/gi,
        replacement: '***GITHUB_TOKEN***'
    },
    {
        name: 'OpenAI API Key',
        regex: /sk-[a-zA-Z0-9]{48,}/gi,
        replacement: '***OPENAI_KEY***'
    },
    {
        name: 'Generic API Key',
        regex: /(?<![a-zA-Z0-9])(?:api[_-]?key|apikey|key)[\s:=]+["']?([a-zA-Z0-9_\-]{20,64})["']?/gi,
        replacement: '***API_KEY***'
    },
    {
        name: 'AWS Access Key',
        regex: /(?:AKIA|ABIA|ACCA|ASIA)[a-zA-Z0-9]{16}/gi,
        replacement: '***AWS_KEY***'
    },
    {
        name: 'JWT Token',
        regex: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/gi,
        replacement: '***JWT***'
    },
    {
        name: 'Private Key',
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi,
        replacement: '***PRIVATE_KEY***'
    },
    {
        name: 'Connection String with Password',
        regex: /(?:mysql|postgres|mongodb|redis):\/\/[^:]+:[^@]+@/gi,
        replacement: '***CONN_STRING***'
    }
];

function maskContent(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }

    let maskedText = text;

    for (const pattern of MASK_PATTERNS) {
        const matches = maskedText.match(pattern.regex);
        if (matches) {
            if (DEBUG_MODE) {
                console.log(`[DataMasking] ${pattern.name}: 替换了 ${matches.length} 处`);
            }
        }
        maskedText = maskedText.replace(pattern.regex, pattern.replacement);
    }

    return maskedText;
}

function maskMessages(messages) {
    if (!Array.isArray(messages)) {
        return messages;
    }

    return messages.map(msg => {
        if (typeof msg.content === 'string') {
            return {
                ...msg,
                content: maskContent(msg.content)
            };
        } else if (Array.isArray(msg.content)) {
            return {
                ...msg,
                content: msg.content.map(part => {
                    if (part.type === 'text' && typeof part.text === 'string') {
                        return {
                            ...part,
                            text: maskContent(part.text)
                        };
                    }
                    return part;
                })
            };
        }
        return msg;
    });
}

module.exports = {
    maskContent,
    maskMessages,
    MASK_PATTERNS
};
