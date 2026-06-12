; Call sites: callee may be a bare name or an attribute chain.
(call function: (identifier) @call.callee)
(call function: (attribute) @call.callee)

; Inheritance: superclass list entries.
(class_definition superclasses: (argument_list (identifier) @extends.name))
(class_definition superclasses: (argument_list (attribute) @extends.name))

; Decorators reference functions/classes.
(decorator (identifier) @reference.name)
(decorator (attribute) @reference.name)
(decorator (call function: (identifier) @reference.name))
(decorator (call function: (attribute) @reference.name))

; Type annotations.
(type (identifier) @reference.name)
