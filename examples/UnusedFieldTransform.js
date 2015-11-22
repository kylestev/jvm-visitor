import * as _ from 'lodash';

import { Jar } from 'jvm';
import { Pipeline } from '../src/Pipeline';
import { ClassVisitor } from '../src/ClassVisitor';
import { Flags } from 'jvm/lib/core/jvm/AccessFlags';

let isVisibleToChildren = (member) => {
  return Flags.isPublic(member.accessFlags) || Flags.isProtected(member.accessFlags);
}

let parentHasVisibleField = (jar, cls, name, desc) => {
  if ( ! _.has(jar, cls.superName)) {
    return false;
  }

  let field = _.find(jar[cls.superName].fields, { name, desc });
  return !! field && isVisibleToChildren(field);
}

class FieldVisitor extends ClassVisitor {
  constructor(jar) {
    super();
    this.jar = jar;
    this.visited = new Set;
  }

  get count() {
    return this.visited.size;
  }

  recordField(cls, field) {
    this.visited.add([cls.name, field.name, field.desc].join(':'));
  }

  toArray() {
    return [...this.visited];
  }
}

class DeclaredFieldVisitor extends FieldVisitor {
  constructor(jar) {
    super(jar);
    this.on('visit-start', (cls) => {
      let parent = jar[cls.superName];
      while (parent) {
        parent.fields
          .filter(isVisibleToChildren)
          .forEach(field => this.recordField(cls, field));

        parent = jar[parent.superName];
      }
    });
    this.on('visit-field', (cls, field) => {
      this.recordField(cls, field);
    });
  }
}

class ReferencedFieldVisitor extends FieldVisitor {
  constructor(jar) {
    super(jar);
    this.on('visit-method', (cls, method) => {
      method.instructions
        .filter(insn => insn.constructor.name === 'FieldInstruction' && insn.owner in jar)
        .forEach(insn => this.visitFieldInstruction(insn));
    });
  }

  visitFieldInstruction(insn) {
    let cls = this.jar[insn.owner];
    let fieldStruct = { name: insn.name, desc: insn.desc };
    this.recordField(cls, fieldStruct);

    let parent = this.jar[cls.superName];
    while (parent) {
      let field = _.find(parent.fields, fieldStruct);
      if ( ! field || ! isVisibleToChildren(field)) {
        break;
      }

      this.recordField(parent, field);

      parent = this.jar[parent.superName];
    }
  }
}

let createFieldUsagePipeline = () => {
  let pipeline = new Pipeline;
  pipeline.addStep('identification', (jar) => {
    let declaredFields = new DeclaredFieldVisitor(jar);
    let referencedFields = new ReferencedFieldVisitor(jar);

    _.values(jar).forEach(cls => {
      declaredFields.accept(cls);
      referencedFields.accept(cls);
    });

    return {
      declared: declaredFields.count,
      referenced: referencedFields.count,
      diff: _.difference(declaredFields.toArray(), referencedFields.toArray())
    };
  });

  return pipeline;
}

Jar.unpack('/path/to/your.jar')
  .then(jar => _.object([...jar]))
  .then(jar => {
    let pipeline = createFieldUsagePipeline();
    pipeline.after(elapsed => {
      let result = pipeline.stepResult('identification');

      console.log('Fields declared but not referenced: %s.', result.diff.length);
      console.log('Fields referenced: %s/%s', result.referenced, result.declared);

      console.log('Unused Field Pipeline completed in %ss', elapsed);
    });

    pipeline.execute(jar);
  })
  .catch(console.error.bind(console));
